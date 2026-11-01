'use strict';
// Vercel entry point (zero-config Express).
// - `express` is required here because Vercel's builder looks for an express import in the entrypoint.
// - The internal modules are required explicitly (they are also required by backend/server.js) so
//   Vercel's file tracer always bundles backend/lib/* into the function.
// The fully configured app (security, routes, Mongo, Blob) is exported unchanged; no listen() on Vercel.
const express = require('express');
require('./backend/lib/db');
require('./backend/lib/indexes');
require('./backend/lib/rate-limit-store');
require('./backend/lib/storage');
require('./backend/lib/pages');
const app = require('./backend/server');

if (typeof express !== 'function' || typeof app !== 'function') {
  throw new Error('backend/server.js must export the Express app');
}

module.exports = app;
