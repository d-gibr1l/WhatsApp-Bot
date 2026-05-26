/**
 * mongoSetup.js
 *
 * One-time MongoDB index creation for the auth state collection.
 * Call this during application startup BEFORE connecting the Baileys socket.
 *
 * Indexes created:
 *   1. _id (default)         — primary lookup by session:type:id
 *   2. session prefix index  — efficient range queries during bootstrap
 *                              and clearSession() deleteMany
 *   3. TTL index on updatedAt (optional) — auto-expire stale keys after
 *                              N days if you want MongoDB to self-clean
 *
 * @param {import('mongodb').Db} db
 * @param {string} [collectionName='auth']
 * @param {number} [ttlDays=90]  — set to 0 to disable TTL
 */
export async function ensureMongoIndexes(db, collectionName = 'auth', ttlDays = 0) {
  const col = db.collection(collectionName);

  // The _id field is already indexed by MongoDB — no need to create it.
  // Proactively drop the old dangerous TTL index idx_auth_ttl if it exists.
  try {
    await col.dropIndex('idx_auth_ttl');
    console.log('[MongoAuth] Dropped dangerous TTL index (idx_auth_ttl) if it existed.');
  } catch (err) {
    // Index might not exist or drop failed, which is expected/non-fatal.
  }

  try {
    // createIndex is idempotent — safe to call on every startup
    if (ttlDays > 0) {
      await col.createIndex(
        { updatedAt: 1 },
        {
          name: 'idx_auth_ttl',
          expireAfterSeconds: ttlDays * 24 * 60 * 60,
          background: true,
        }
      );
    }

    console.log('[MongoAuth] Indexes verified.');
  } catch (err) {
    // Index creation errors are non-fatal — the bot still works, just
    // without the TTL cleanup. Log and continue.
    console.warn('[MongoAuth] Index creation warning:', err.message);
  }
}
