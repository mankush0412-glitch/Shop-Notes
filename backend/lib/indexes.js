'use strict';
// Idempotent. Runs once per serverless instance (non-fatal) and can also be run
// manually with: npm run indexes

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('products').createIndex({ id:1 }, { unique:true }),
    db.collection('products').createIndex({ active:1, createdAt:1 }),
    db.collection('products').createIndex({ privateFileId:1 }, { sparse:true }),
    db.collection('product_files').createIndex({ createdAt:1 }),
    db.collection('product_files').createIndex({ blobPathname:1 }, { sparse:true }),
    db.collection('orders').createIndex({ id:1 }, { unique:true }),
    db.collection('orders').createIndex({ userId:1, createdAt:-1 }),
    db.collection('orders').createIndex({ status:1, createdAt:-1 }),
    db.collection('orders').createIndex({ 'items.privateFileId':1 }, { sparse:true }),
    db.collection('orders').createIndex({ utr:1 }),
    db.collection('users').createIndex({ tokenHash:1 }, { unique:true }),
    db.collection('users').createIndex({ email:1 }),
    db.collection('users').createIndex({ lastSeenAt:-1 }),
    db.collection('users').createIndex({ googleSub:1 }, { unique:true, sparse:true }),
    db.collection('admin_login_attempts').createIndex({ expiresAt:1 }, { expireAfterSeconds:0 }),
    db.collection('checkout_quotes').createIndex({ expiresAt:1 }, { expireAfterSeconds:0 }),
    db.collection('checkout_quotes').createIndex({ userId:1, createdAt:-1 }),
    db.collection('checkout_quotes').createIndex({ 'items.privateFileId':1 }, { sparse:true }),
    db.collection('rate_limits').createIndex({ expiresAt:1 }, { expireAfterSeconds:0 })
  ]);
}

module.exports = { ensureIndexes };
