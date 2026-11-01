'use strict';
// Usage: npm run indexes   (needs MONGODB_URI in .env or the environment)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getMongo } = require('../backend/lib/db');
const { ensureIndexes } = require('../backend/lib/indexes');

(async () => {
  const client = await getMongo();
  const db = client.db(process.env.MONGODB_DB || 'next_level_notes');
  await ensureIndexes(db);
  console.log('Indexes are in place on database:', db.databaseName);
  await client.close();
})().catch(err => { console.error('Index creation failed:', err.message); process.exit(1); });
