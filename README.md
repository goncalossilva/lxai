# lxai
https://lisbonai.xyz/ static site archive

## Overview

This repository contains a Playwright-based web crawler that archives the lisbonai.xyz website as a static HTML site. The crawler:

- Renders JavaScript-heavy pages using Chromium
- Crawls only the exact lisbonai.xyz domain (no subdomains)
- Keeps external and subdomain links external
- Downloads all assets (CSS, JS, images, fonts)
- Rewrites internal links to local paths
- Outputs a deployable static site

## Usage

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Install Playwright browsers:
```bash
npx playwright install chromium
```

3. Run the archiver:
```bash
npm run archive
```

The static site will be generated in the `output/` directory.

### GitHub Actions

The repository includes a GitHub Actions workflow that can be triggered manually to:
1. Run the archiver
2. Deploy the generated static site to the `gh-pages` branch

To trigger the workflow:
1. Go to the Actions tab in the repository
2. Select "Archive lisbonai.xyz" workflow
3. Click "Run workflow"

The archived site will be available via GitHub Pages.
