'use strict';
// MongoDB connection cached on globalThis so every warm Vercel invocation reuses
// the same pool instead of opening a new connection per request.
const { MongoClient } = require('mongodb');

function getMongo() {
  if (!globalThis.__nlnMongoPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is required');
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      socketTimeoutMS: 15000
    });
    globalThis.__nlnMongoPromise = client.connect().catch(err => {
      globalThis.__nlnMongoPromise = null; // allow retry on the next request
      throw err;
    });
  }
  return globalThis.__nlnMongoPromise;
}

module.exports = { getMongo };
