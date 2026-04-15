import { cp, mkdir, readdir, rm } from 'fs/promises';
import { join } from 'path';

const DIST_DIR = 'dist';
const EXCLUDED_TOP_LEVEL_ENTRIES = new Set([
  '.git',
  '.github',
  '.gitignore',
  '.DS_Store',
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'dist',
  'node_modules',
  'output',
  'package-lock.json',
  'package.json',
  'scripts',
  'test-output'
]);

await buildPages();

async function buildPages() {
  const entries = await getEntriesToPublish();

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  for (const entry of entries) {
    await cp(entry, join(DIST_DIR, entry), { recursive: true });
  }

  console.log(`Prepared ${entries.length} top-level entries in ${DIST_DIR}/`);
}

async function getEntriesToPublish() {
  const entries = await readdir('.', { withFileTypes: true });

  return entries
    .map((entry) => entry.name)
    .filter((entry) => !EXCLUDED_TOP_LEVEL_ENTRIES.has(entry))
    .sort();
}
