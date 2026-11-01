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

const GENERATED = path.join(root, 'backend', 'lib', 'pages.js'); // embedded HTML, generated
const files = [...walk(path.join(root, 'backend')), path.join(root, 'index.js')]
  .filter(f => fs.existsSync(f) && f !== GENERATED);
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

// Every relative require()/import() in project code must resolve to a real file (catches the
// "Cannot find module './lib/db'" class of deployment problems before Vercel runs the app).
const PROBE = new RegExp('(?:require|import)\\(\\s*([\'"])(\\.{1,2}/[^\'"]+)\\1\\s*\\)', 'g');
const scanForRequires = [...walk(path.join(root, 'backend')), ...walk(path.join(root, 'scripts')), path.join(root, 'index.js')]
  .filter(f => fs.existsSync(f) && f !== GENERATED && f !== __filename);
for (const file of scanForRequires) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(PROBE)) {
    const base = path.resolve(path.dirname(file), m[2]);
    const found = [base, base + '.js', base + '.json', path.join(base, 'index.js')]
      .some(c => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) problems.push(`${path.relative(root, file)}: require('${m[2]}') does not resolve to a file`);
  }
}

// Every storage.<fn> used by server.js must be exported by backend/lib/storage.js.
try {
  const serverSrc = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
  const storageExports = Object.keys(require(path.join(root, 'backend', 'lib', 'storage.js')));
  for (const name of new Set([...serverSrc.matchAll(/\bstorage\.([A-Za-z]+)\(/g)].map(m => m[1]))) {
    if (!storageExports.includes(name)) problems.push(`backend/server.js calls storage.${name}() but backend/lib/storage.js does not export it`);
  }
} catch (err) {
  problems.push('could not verify storage exports: ' + err.message);
}

// Embedded fallback pages must match public/*.
try {
  const { collect, hashOf } = require('./build-pages.js');
  const embedded = require(path.join(root, 'backend', 'lib', 'pages.js'));
  if (embedded.hash !== hashOf(collect())) problems.push('backend/lib/pages.js is out of date. Run: npm run build:pages');
} catch (err) {
  problems.push('backend/lib/pages.js missing or unreadable. Run: npm run build:pages (' + err.message + ')');
}

const server = path.join(root, 'backend', 'server.js');
if (!fs.existsSync(server)) problems.push('backend/server.js is missing');
else if (!fs.readFileSync(server, 'utf8').includes("require('./lib" + "/storage')")) {
  problems.push('backend/server.js is the OLD pre-Vercel version (it does not use ./lib/storage). Replace it with the Vercel version.');
}
for (const stale of ['server.js', 'app.js', path.join('backend', 'package.json')]) {
  if (fs.existsSync(path.join(root, stale))) problems.push(`Stale file present: ${stale} (delete it)`);
}
for (const dir of ['private_storage', path.join('public', 'uploads')]) {
  if (fs.existsSync(path.join(root, dir))) problems.push(`Stale directory present: ${dir} (delete it, files live in Vercel Blob)`);
}

if (problems.length) {
  console.error('\nDEPLOYMENT GUARD FAILED:');
  for (const p of problems) console.error('  - ' + p);
  console.error('');
  process.exit(1);
}
console.log('Deployment guard passed: Blob-only storage, all require() paths resolve, embedded pages are current.');
