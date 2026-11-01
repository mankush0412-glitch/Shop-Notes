'use strict';
// Vercel entry point (zero-config Express). The Express app is exported, never listened on.
const app = require('./backend/server');

module.exports = app;
