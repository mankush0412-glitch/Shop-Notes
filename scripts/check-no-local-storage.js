'use strict';
// Build guard: fails the Vercel build if any runtime code still uses the local filesystem
// for product files (images / paid ZIPs), or if a stale pre-Vercel server.js is deployed.
// Runtime file storage is Vercel Blob only (backend/lib/storage.js).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const problems = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); }
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(root, 'backend')), path.join(root, 'index.js')].filter(f => fs.existsSync(f));
const forbidden = [
  [/private_storage/, 'private_storage directory'],
  [/PRIVATE_PRODUCT/, 'PRIVATE_PRODUCT_DIR / temp dir'],
  [/diskStorage/, 'multer.diskStorage'],
  [/\bmkdir(?:Sync)?\b/, 'mkdir'],
  [/createWriteStream|createReadStream/, 'fs streams'],
  [/\bwriteFile(?:Sync)?\b/, 'writeFile'],
  [/\bunlink(?:Sync)?\b/, 'unlink'],
  [/require\((['"])(?:node:)?fs\1\)/, "require('fs')"],
  [/fs\.promises/, 'fs.promises'],
  [/os\.tmpdir/, 'os.tmpdir'],
  [/\bchmod(?:Sync)?\b/, 'chmod']
];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const [re, label] of forbidden) {
    if (re.test(src)) problems.push(`${path.relative(root, file)}: uses ${label}`);
  }
}

const server = path.join(root, 'backend', 'server.js');
if (!fs.existsSync(server)) problems.push('backend/server.js is missing');
else if (!fs.readFileSync(server, 'utf8').includes("require('./lib/storage')")) {
  problems.push('backend/server.js is the OLD pre-Vercel version (it does not use ./lib/storage). Replace it with the Vercel version.');
}
for (const stale of ['server.js', 'app.js', path.join('backend', 'package.json')]) {
  if (fs.existsSync(path.join(root, stale))) problems.push(`Stale file present: ${stale} (delete it)`);
}
for (const dir of ['private_storage', path.join('public', 'uploads')]) {
  if (fs.existsSync(path.join(root, dir))) problems.push(`Stale directory present: ${dir} (delete it, files live in Vercel Blob)`);
}

if (problems.length) {
  console.error('\nLOCAL STORAGE GUARD FAILED:');
  for (const p of problems) console.error('  - ' + p);
  console.error('');
  process.exit(1);
}
console.log('Local storage guard passed: product files use Vercel Blob only.');
