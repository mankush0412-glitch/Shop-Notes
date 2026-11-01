'use strict';
// express-rate-limit store backed by MongoDB. The default MemoryStore keeps
// counters per serverless instance, so limits would not hold across instances.
// Documents expire automatically via the TTL index on rate_limits.expiresAt.

class MongoRateLimitStore {
  constructor(prefix, getDb) {
    this.prefix = String(prefix);
    this.getDb = getDb;
    this.windowMs = 60 * 1000;
  }
  init(options) { this.windowMs = options.windowMs; }
  collection() { return this.getDb().collection('rate_limits'); }
  id(key) { return `${this.prefix}:${key}`; }

  async get(key) {
    const doc = await this.collection().findOne({ _id:this.id(key) });
    if (!doc || !doc.expiresAt || doc.expiresAt <= new Date()) return undefined;
    return { totalHits:doc.hits, resetTime:doc.expiresAt };
  }

  async increment(key) {
    const now = new Date();
    const next = new Date(now.getTime() + this.windowMs);
    const doc = await this.collection().findOneAndUpdate(
      { _id:this.id(key) },
      [{
        $set: {
          hits: { $cond: [ { $gt:['$expiresAt', now] }, { $add:[ { $ifNull:['$hits', 0] }, 1 ] }, 1 ] },
          expiresAt: { $cond: [ { $gt:['$expiresAt', now] }, '$expiresAt', next ] }
        }
      }],
      { upsert:true, returnDocument:'after' }
    );
    return { totalHits:doc.hits, resetTime:doc.expiresAt };
  }

  async decrement(key) {
    await this.collection().updateOne({ _id:this.id(key), hits:{ $gt:0 } }, { $inc:{ hits:-1 } });
  }

  async resetKey(key) {
    await this.collection().deleteOne({ _id:this.id(key) });
  }

  async resetAll() {
    await this.collection().deleteMany({ _id:{ $regex:`^${this.prefix}:` } });
  }
}

module.exports = { MongoRateLimitStore };
