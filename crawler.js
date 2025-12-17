import { chromium } from 'playwright';
import { mkdir, writeFile, copyFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { dirname, join, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const TARGET_DOMAIN = 'lisbonai.xyz';
const START_URL = `https://${TARGET_DOMAIN}`;
const OUTPUT_DIR = './output';

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

  async downloadAsset(url, localPath) {
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
            const currentLocalPath = this.getLocalPath(currentUrl);
            const currentDir = dirname(currentLocalPath);
            const relativePath = currentDir === '.' ? localPath : relative(currentDir, localPath);
            // Fix Windows-style paths for web
            return `href="${relativePath.replace(/\\/g, '/')}"`;
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
        const absoluteUrl = new URL(url, currentUrl).href;
        
        if (this.isTargetDomain(absoluteUrl)) {
          // Internal asset
          const localPath = this.getLocalPath(absoluteUrl);
          if (localPath) {
            const currentLocalPath = this.getLocalPath(currentUrl);
            const currentDir = dirname(currentLocalPath);
            const relativePath = currentDir === '.' ? localPath : relative(currentDir, localPath);
            // Fix Windows-style paths for web
            return `src="${relativePath.replace(/\\/g, '/')}"`;
          }
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
            const absoluteUrl = new URL(url, currentUrl).href;
            if (this.isTargetDomain(absoluteUrl)) {
              const localPath = this.getLocalPath(absoluteUrl);
              if (localPath) {
                const currentLocalPath = this.getLocalPath(currentUrl);
                const currentDir = dirname(currentLocalPath);
                const relativePath = currentDir === '.' ? localPath : relative(currentDir, localPath);
                return descriptor ? `${relativePath.replace(/\\/g, '/')} ${descriptor}` : relativePath.replace(/\\/g, '/');
              }
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

      // Download CSS files
      const cssUrls = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
        return links.map(link => link.href);
      });

      for (const cssUrl of cssUrls) {
        if (this.isTargetDomain(cssUrl)) {
          const localPath = this.getLocalPath(cssUrl);
          if (localPath) {
            await this.downloadAsset(cssUrl, localPath);
          }
        }
      }

      // Download JS files
      const jsUrls = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        return scripts.map(script => script.src);
      });

      for (const jsUrl of jsUrls) {
        if (this.isTargetDomain(jsUrl)) {
          const localPath = this.getLocalPath(jsUrl);
          if (localPath) {
            await this.downloadAsset(jsUrl, localPath);
          }
        }
      }

      // Download images
      const imageUrls = await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img[src]'));
        return images.map(img => img.src);
      });

      for (const imgUrl of imageUrls) {
        if (this.isTargetDomain(imgUrl)) {
          const localPath = this.getLocalPath(imgUrl);
          if (localPath) {
            await this.downloadAsset(imgUrl, localPath);
          }
        }
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
        try {
          const absoluteUrl = new URL(srcsetUrl, url).href;
          if (this.isTargetDomain(absoluteUrl)) {
            const localPath = this.getLocalPath(absoluteUrl);
            if (localPath) {
              await this.downloadAsset(absoluteUrl, localPath);
            }
          }
        } catch (error) {
          // Ignore invalid URLs
        }
      }

      // Download fonts
      const fontUrls = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel~="preload"][as="font"]'));
        return links.map(link => link.href);
      });

      for (const fontUrl of fontUrls) {
        if (this.isTargetDomain(fontUrl)) {
          const localPath = this.getLocalPath(fontUrl);
          if (localPath) {
            await this.downloadAsset(fontUrl, localPath);
          }
        }
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
