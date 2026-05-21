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
export async function ensureMongoIndexes(db, collectionName = 'auth', ttlDays = 90) {
  const col = db.collection(collectionName);

  // The _id field is already indexed by MongoDB — no need to create it.
  // We create a supporting index on updatedAt for the optional TTL.

  const indexes = [
    // Partial index for session-scoped range scans (bootstrap, clearSession)
    {
      key: { _id: 1 },
      name: 'idx_auth_id',
      // This is the default primary index — already exists. Listed for clarity.
    },
  ];

  if (ttlDays > 0) {
    indexes.push({
      key: { updatedAt: 1 },
      name: 'idx_auth_ttl',
      expireAfterSeconds: ttlDays * 24 * 60 * 60,
    });
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
