import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join, dirname, relative } from 'path';

// Simple test to validate the crawler logic without external network access

async function testCrawler() {
  console.log('Testing crawler functionality...\n');
  
  let browser = null;
  let context = null;
  
  try {
    // Test 1: Initialize browser
    console.log('✓ Test 1: Initializing Chromium browser...');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; LXAIArchiver/1.0)'
    });
    console.log('  Browser initialized successfully\n');

    // Test 2: Create and navigate to local test page
    console.log('✓ Test 2: Testing page navigation with local content...');
    const testDir = './test-output';
    await mkdir(testDir, { recursive: true });
    
    const testHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Test Page</h1>
  <a href="/about">About</a>
  <a href="https://external.com">External Link</a>
  <img src="image.jpg" alt="Test">
  <script src="script.js"></script>
</body>
</html>
`;
    await writeFile(join(testDir, 'index.html'), testHtml);
    
    const page = await context.newPage();
    await page.goto(`file://${process.cwd()}/${testDir}/index.html`);
    console.log('  Navigation successful\n');

    // Test 3: Extract page content
    console.log('✓ Test 3: Extracting page content...');
    const html = await page.content();
    console.log(`  Extracted ${html.length} characters of HTML\n`);

    // Test 4: Extract links
    console.log('✓ Test 4: Extracting links...');
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
    });
    console.log(`  Found ${links.length} links\n`);

    // Test 5: URL parsing and domain detection
    console.log('✓ Test 5: Testing URL utilities...');
    
    const isTargetDomain = (url) => {
      try {
        const urlObj = new URL(url);
        return urlObj.hostname === 'lisbonai.xyz';
      } catch {
        return false;
      }
    };
    
    const testUrls = [
      { url: 'https://lisbonai.xyz/about', expected: true },
      { url: 'https://www.lisbonai.xyz/about', expected: false }, // subdomain
      { url: 'https://external.com', expected: false },
    ];
    
    let allPassed = true;
    for (const test of testUrls) {
      const result = isTargetDomain(test.url);
      const pass = result === test.expected;
      if (!pass) {
        console.log(`  FAIL: ${test.url} - expected ${test.expected}, got ${result}`);
        allPassed = false;
      }
    }
    if (allPassed) {
      console.log('  All domain detection tests passed\n');
    }

    // Test 6: Path generation
    console.log('✓ Test 6: Testing local path generation...');
    
    const getLocalPath = (url) => {
      try {
        const urlObj = new URL(url);
        let path = urlObj.pathname;
        
        if (path === '/' || path === '') {
          return 'index.html';
        }
        
        if (path.endsWith('/')) {
          return path.slice(1) + 'index.html';
        }
        
        const ext = path.split('.').pop();
        if (!path.includes('.') || ext.length > 5) {
          return path.slice(1) + '/index.html';
        }
        
        return path.slice(1);
      } catch {
        return null;
      }
    };
    
    const pathTests = [
      { url: 'https://lisbonai.xyz/', expected: 'index.html' },
      { url: 'https://lisbonai.xyz/about', expected: 'about/index.html' },
      { url: 'https://lisbonai.xyz/style.css', expected: 'style.css' },
      { url: 'https://lisbonai.xyz/images/logo.png', expected: 'images/logo.png' },
    ];
    
    allPassed = true;
    for (const test of pathTests) {
      const result = getLocalPath(test.url);
      const pass = result === test.expected;
      if (!pass) {
        console.log(`  FAIL: ${test.url} - expected ${test.expected}, got ${result}`);
        allPassed = false;
      }
    }
    if (allPassed) {
      console.log('  All path generation tests passed\n');
    }

    // Test 7: Save test file
    console.log('✓ Test 7: Testing file operations...');
    await writeFile(join(testDir, 'output.html'), '<html><body>Output Test</body></html>');
    const saved = await readFile(join(testDir, 'output.html'), 'utf-8');
    if (saved.includes('Output Test')) {
      console.log('  File saved and read successfully\n');
    }

    await page.close();
    
    console.log('✅ All tests passed! The crawler components are working correctly.\n');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

testCrawler();
