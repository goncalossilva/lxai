# lxai

This repository contains the editable Lisbon AI website at the repository root and the scripts used to publish it.

## Repository layout

- `/` — website source and the version served at `https://lisbonai.xyz/`
- `/2025/` — frozen 2025 site snapshot served at `https://lisbonai.xyz/2025/`
- `/scripts/` — build and deployment scripts

## Hard rule

Do not change anything under `/2025/`.

## Local workflow

Edit the website directly in the repository root.

```bash
npm run build:pages
```

That builds the GitHub Pages payload into `dist/`.

## Deployment

Pushes to `main` deploy the built site to GitHub Pages. The deployment includes the site at `/` and the frozen `/2025/` snapshot.
