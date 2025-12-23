import { chromium } from 'playwright';
import { mkdir, writeFile, copyFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { dirname, join, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const TARGET_DOMAIN = 'lisbonai.xyz';
const START_URL = `https://${TARGET_DOMAIN}`;
const OUTPUT_DIR = './output';
const ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm'
]);
const isHttpProtocol = (urlObj) => ['http:', 'https:'].includes(urlObj.protocol);

class StaticSiteArchiver {
  constructor() {
    this.visitedUrls = new Set();
    this.urlQueue = new Set([START_URL]);
    this.assets = new Map(); // Maps URL to local path
    this.browser = null;
    this.context = null;
  }

  async init() {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; LXAIArchiver/1.0)'
    });
  }

  async close() {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }

  isTargetDomain(url) {
    try {
      const urlObj = new URL(url);
      // Only exact domain match, no subdomains
      return urlObj.hostname === TARGET_DOMAIN;
    } catch {
      return false;
    }
  }

  normalizeUrl(url) {
    try {
      const urlObj = new URL(url);
      // Remove hash
      urlObj.hash = '';
      // Normalize trailing slash
      if (urlObj.pathname.endsWith('/') && urlObj.pathname.length > 1) {
        urlObj.pathname = urlObj.pathname.slice(0, -1);
      }
      return urlObj.href;
    } catch {
      return url;
    }
  }

  getLocalPath(url) {
    try {
      const urlObj = new URL(url);
      let path = urlObj.pathname;
      
      // Root path
      if (path === '/' || path === '') {
        return 'index.html';
      }
      
      // If path ends with /, treat as directory with index.html
      if (path.endsWith('/')) {
        return path.slice(1) + 'index.html';
      }
      
      // If no extension, treat as directory
      const ext = extname(path);
      if (!ext) {
        return path.slice(1) + '/index.html';
      }
      
      // Return path as-is (without leading /)
      return path.slice(1);
    } catch {
      return null;
    }
  }

  getAssetLocalPath(url) {
    try {
      const basePath = this.getLocalPath(url);
      if (!basePath) return null;

      const urlObj = new URL(url);
      if (this.isTargetDomain(url)) {
        return basePath;
      }

      return join('external', urlObj.hostname, basePath);
    } catch {
      return null;
    }
  }

  getRelativePath(currentUrl, targetLocalPath) {
    const currentLocalPath = this.getLocalPath(currentUrl);
    if (!currentLocalPath) {
      return targetLocalPath.replace(/\\/g, '/');
    }

    const currentDir = dirname(currentLocalPath);
    const relativePath = currentDir === '.' ? targetLocalPath : relative(currentDir, targetLocalPath);
    return relativePath.replace(/\\/g, '/');
  }

  resolveHttpUrl(url, baseUrl) {
    try {
      const absoluteUrl = new URL(url, baseUrl).href;
      const urlObj = new URL(absoluteUrl);
      if (!isHttpProtocol(urlObj)) return null;
      return { absoluteUrl, urlObj };
    } catch {
      return null;
    }
  }

  isAssetUrl(urlObj) {
    const ext = extname(urlObj.pathname).toLowerCase();
    return ASSET_EXTENSIONS.has(ext);
  }

  async downloadHttpAsset(url, baseUrl, { logLabel, requireAssetExtension = false } = {}) {
    const resolved = this.resolveHttpUrl(url, baseUrl);
    if (!resolved) {
      if (logLabel) {
        console.warn(`  Skipping invalid ${logLabel} URL: ${url}`);
      }
      return;
    }

    if (requireAssetExtension && !this.isAssetUrl(resolved.urlObj)) return;

    const localPath = this.getAssetLocalPath(resolved.absoluteUrl);
    if (localPath) {
      await this.downloadAsset(resolved.absoluteUrl, localPath);
    }
  }

  async downloadAsset(url, localPath) {
    if (!localPath) {
      console.warn(`  Skipping asset without resolved local path: ${url}`);
      return null;
    }

    if (this.assets.has(url)) {
      return this.assets.get(url);
    }

    try {
      const fullPath = join(OUTPUT_DIR, localPath);
      await mkdir(dirname(fullPath), { recursive: true });

      const page = await this.context.newPage();
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      
      if (response && response.ok()) {
        const buffer = await response.body();
        await writeFile(fullPath, buffer);
        this.assets.set(url, localPath);
        console.log(`  Downloaded asset: ${url} -> ${localPath}`);
      }
      
      await page.close();
      return localPath;
    } catch (error) {
      console.error(`  Failed to download asset ${url}:`, error.message);
      return null;
    }
  }

  async rewriteHtml(html, currentUrl) {
    const urlObj = new URL(currentUrl);
    const currentPath = urlObj.pathname;

    // Rewrite links in HTML
    let rewritten = html;

    // Rewrite href attributes
    const hrefRegex = /href=["']([^"']+)["']/g;
    rewritten = rewritten.replace(hrefRegex, (match, url) => {
      try {
        const absoluteUrl = new URL(url, currentUrl).href;
        const normalized = this.normalizeUrl(absoluteUrl);
        
        if (this.isTargetDomain(normalized)) {
          // Internal link - rewrite to local path
          const localPath = this.getLocalPath(normalized);
          if (localPath) {
            const relativePath = this.getRelativePath(currentUrl, localPath);
            return `href="${relativePath}"`;
          }
        }

        const resolved = this.resolveHttpUrl(url, currentUrl);
        if (resolved && this.isAssetUrl(resolved.urlObj)) {
          const assetLocalPath = this.getAssetLocalPath(resolved.absoluteUrl);
          if (assetLocalPath) {
            const relativePath = this.getRelativePath(currentUrl, assetLocalPath);
            return `href="${relativePath}"`;
          }
        }
        // External link - keep as-is
        return match;
      } catch {
        return match;
      }
    });

    // Rewrite src attributes
    const srcRegex = /src=["']([^"']+)["']/g;
    rewritten = rewritten.replace(srcRegex, (match, url) => {
      try {
        const resolved = this.resolveHttpUrl(url, currentUrl);
        if (!resolved) {
          return match;
        }

        const localPath = this.getAssetLocalPath(resolved.absoluteUrl);
        if (localPath) {
          const relativePath = this.getRelativePath(currentUrl, localPath);
          return `src="${relativePath}"`;
        }
        // External asset - keep as-is
        return match;
      } catch {
        return match;
      }
    });

    // Rewrite srcset attributes for responsive images
    const srcsetRegex = /srcset=["']([^"']+)["']/g;
    rewritten = rewritten.replace(srcsetRegex, (match, srcset) => {
      try {
        const entries = srcset.split(',').map(entry => {
          const parts = entry.trim().split(/\s+/);
          if (parts.length === 0) return entry;
          
          const url = parts[0];
          const descriptor = parts.slice(1).join(' ');
          
          try {
            const resolved = this.resolveHttpUrl(url, currentUrl);
            if (!resolved) {
              return entry;
            }

            const localPath = this.getAssetLocalPath(resolved.absoluteUrl);
            if (localPath) {
              const relativePath = this.getRelativePath(currentUrl, localPath);
              return descriptor ? `${relativePath} ${descriptor}` : relativePath;
            }
            return entry;
          } catch {
            return entry;
          }
        });
        return `srcset="${entries.join(', ')}"`;
      } catch {
        return match;
      }
    });

    return rewritten;
  }

  async crawlPage(url) {
    if (this.visitedUrls.has(url)) {
      return;
    }

    console.log(`Crawling: ${url}`);
    this.visitedUrls.add(url);

    const page = await this.context.newPage();
    
    try {
      // Navigate and wait for page to be fully loaded
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      
      // Wait a bit more for any lazy-loaded content
      await page.waitForTimeout(2000);

      // Get all links on the page
      const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors.map(a => a.href);
      });

      // Add internal links to queue
      for (const link of links) {
        const normalized = this.normalizeUrl(link);
        if (this.isTargetDomain(normalized) && !this.visitedUrls.has(normalized)) {
          this.urlQueue.add(normalized);
        }
      }

      // Get page HTML
      const html = await page.content();

      // Rewrite HTML to use local paths
      const rewrittenHtml = await this.rewriteHtml(html, url);

      // Save HTML file
      const localPath = this.getLocalPath(url);
      if (localPath) {
        const fullPath = join(OUTPUT_DIR, localPath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, rewrittenHtml);
        console.log(`  Saved: ${localPath}`);
      }

      // Download asset hrefs (e.g., icons, external assets)
      const assetHrefUrls = await page.evaluate(() => {
        const linkElements = Array.from(document.querySelectorAll('link[href]:not([rel="stylesheet"])'));
        const downloadableAnchors = Array.from(document.querySelectorAll('a[href][download]'));
        const elements = [...linkElements, ...downloadableAnchors];
        return elements.map(el => ({ href: el.href, tag: el.tagName }));
      });

      for (const asset of assetHrefUrls) {
        const tag = asset.tag.toLowerCase();
        await this.downloadHttpAsset(asset.href, url, { logLabel: `${tag} href`, requireAssetExtension: true });
      }

      // Download CSS files
      const cssUrls = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
        return links.map(link => link.href);
      });

      for (const cssUrl of cssUrls) {
        await this.downloadHttpAsset(cssUrl, url, { logLabel: 'stylesheet' });
      }

      // Download JS files
      const jsUrls = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        return scripts.map(script => script.src);
      });

      for (const jsUrl of jsUrls) {
        await this.downloadHttpAsset(jsUrl, url, { logLabel: 'script' });
      }

      // Download images
      const imageUrls = await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img[src]'));
        return images.map(img => img.src);
      });

      for (const imgUrl of imageUrls) {
        await this.downloadHttpAsset(imgUrl, url, { logLabel: 'image' });
      }

      // Download srcset images
      const srcsetUrls = await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img[srcset]'));
        const urls = [];
        images.forEach(img => {
          const srcset = img.getAttribute('srcset');
          if (srcset) {
            srcset.split(',').forEach(entry => {
              const url = entry.trim().split(/\s+/)[0];
              if (url) urls.push(url);
            });
          }
        });
        return urls;
      });

      for (const srcsetUrl of srcsetUrls) {
        await this.downloadHttpAsset(srcsetUrl, url, { logLabel: 'srcset image' });
      }

      // Download fonts
      const fontUrls = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel~="preload"][as="font"]'));
        return links.map(link => link.href);
      });

      for (const fontUrl of fontUrls) {
        await this.downloadHttpAsset(fontUrl, url, { logLabel: 'font' });
      }

    } catch (error) {
      console.error(`  Error crawling ${url}:`, error.message);
    } finally {
      await page.close();
    }
  }

  async crawl() {
    await this.init();

    try {
      while (this.urlQueue.size > 0) {
        const url = this.urlQueue.values().next().value;
        this.urlQueue.delete(url);
        await this.crawlPage(url);
      }

      console.log('\n=== Crawl Summary ===');
      console.log(`Pages crawled: ${this.visitedUrls.size}`);
      console.log(`Assets downloaded: ${this.assets.size}`);
      console.log(`Output directory: ${OUTPUT_DIR}`);
    } finally {
      await this.close();
    }
  }
}

// Main execution
const archiver = new StaticSiteArchiver();
await archiver.crawl();
