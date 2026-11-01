'use strict';
// Bundles the Vercel Blob browser client into public/vendor/blob-client.js so the
// admin page can upload large ZIPs straight to Blob (no CDN, no unpinned imports).
// Run: npm run build:client   -- then COMMIT public/vendor/blob-client.js
const path = require('path');
const fs = require('fs');

const out = path.join(__dirname, '..', 'public', 'vendor', 'blob-client.js');
(async () => {
  try {
    const esbuild = require('esbuild');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'blob-client-entry.js')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      legalComments: 'none',
      outfile: out
    });
    console.log('Built', path.relative(process.cwd(), out));
  } catch (err) {
    console.warn('WARNING: could not build the Blob browser client:', err.message);
    console.warn(fs.existsSync(out) ? 'Using the existing public/vendor/blob-client.js.' : 'Admin ZIP uploads will not work until you run: npm install && npm run build:client');
  }
})();
