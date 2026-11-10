#!/usr/bin/env node
// Project inventory for /docs-update, printed as JSON. Port of `gsd-tools query docs-init`
// (open-gsd/gsd-core src/docs.cts, MIT). Run from the project root.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MARKERS = ['<!-- generated-by: gsd-doc-writer -->', '<!-- generated-by: codebase-mapper -->'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.planning', '.claude', '.tmp', '__pycache__',
  'target', 'dist', 'build', '.next', '.nuxt', 'coverage', '.vscode', '.idea',
]);

const root = process.cwd();
const exists = (rel) => fs.existsSync(path.join(root, rel));
const readText = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
const readJson = (rel) => { try { return JSON.parse(readText(rel)); } catch { return null; } };
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
};

// Only the first 500 bytes: the marker is always on the first line(s).
function hasMarker(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(500);
    const n = fs.readSync(fd, buf, 0, 500, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    return MARKERS.some((m) => head.includes(m));
  } catch { return false; }
}

const existingDocs = [];
const addDoc = (abs) => existingDocs.push({ path: path.relative(root, abs).split(path.sep).join('/'), has_marker: hasMarker(abs) });
const isMd = (e) => e.isFile() && e.name.toLowerCase().endsWith('.md');

function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, depth + 1);
    else if (isMd(e)) addDoc(abs);
  }
}

for (const e of fs.readdirSync(root, { withFileTypes: true })) if (isMd(e)) addDoc(path.join(root, e.name));
const docsDir = ['docs', 'documentation', 'doc'].find((d) => fs.statSync(path.join(root, d), { throwIfNoEntry: false })?.isDirectory());
if (docsDir) walk(path.join(root, docsDir), 1);
existingDocs.sort((a, b) => a.path.localeCompare(b.path));

const pkg = readJson('package.json');
const bin = pkg?.bin;
const devDeps = Object.keys(pkg?.devDependencies ?? {});

let workspaces = (readText('pnpm-workspace.yaml') ?? '').split('\n')
  .map((l) => l.match(/^\s*-\s+['"]?(.+?)['"]?\s*$/)?.[1].trim())
  .filter(Boolean);
if (!workspaces.length && Array.isArray(pkg?.workspaces)) workspaces = pkg.workspaces;
if (!workspaces.length && Array.isArray(readJson('lerna.json')?.packages)) workspaces = readJson('lerna.json').packages;

const inGit = git('rev-parse', '--is-inside-work-tree') === 'true';
// check-ignore exits 0 (empty output) when ignored, 1 (null here) when not
const docsIgnored = inGit && git('check-ignore', '-q', 'docs/') !== null;

console.log(JSON.stringify({
  project_root: root,
  commit_docs: inGit && !docsIgnored,
  existing_docs: existingDocs,
  project_type: {
    has_package_json: exists('package.json'),
    has_api_routes: ['src/app/api', 'routes', 'src/routes', 'api', 'server'].some(exists),
    has_cli_bin: !!(bin && (typeof bin === 'string' || Object.keys(bin).length > 0)),
    is_open_source: exists('LICENSE') || exists('LICENSE.md'),
    has_deploy_config: [
      'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'fly.toml', 'render.yaml',
      'vercel.json', 'netlify.toml', 'railway.json', '.github/workflows/deploy.yml', '.github/workflows/deploy.yaml',
    ].some(exists),
    is_monorepo: exists('pnpm-workspace.yaml') || exists('lerna.json') || (Array.isArray(pkg?.workspaces) && pkg.workspaces.length > 0),
    has_tests: ['test', 'tests', '__tests__', 'spec'].some(exists) || devDeps.some((d) => ['vitest', 'jest', 'mocha', 'jasmine', 'ava'].includes(d)),
  },
  doc_tooling: {
    docusaurus: exists('docusaurus.config.js') || exists('docusaurus.config.ts'),
    vitepress: ['.vitepress/config.js', '.vitepress/config.ts', '.vitepress/config.mts'].some(exists),
    mkdocs: exists('mkdocs.yml'),
    storybook: exists('.storybook'),
  },
  monorepo_workspaces: workspaces,
}, null, 2));
