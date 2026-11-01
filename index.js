'use strict';
// Vercel entry point (zero-config Express).
// Vercel's builder scans the entrypoint for an `express` import, so express is required
// here explicitly. The fully configured app (security, routes, Mongo, Blob) lives in
// backend/server.js and is exported unchanged; it never calls listen() on Vercel.
const express = require('express');
const app = require('./backend/server');

if (typeof express !== 'function' || typeof app !== 'function') {
  throw new Error('backend/server.js must export the Express app');
}

module.exports = app;
