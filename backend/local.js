'use strict';
// Local development entry: `npm start` / `npm run dev`.
// On Vercel this file is NOT used; Vercel runs the exported app from /index.js.
const app = require('./server');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  console.log(`Next Level notes (local) listening on http://${HOST}:${PORT}`);
});
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
