/**
 * mongoSession.js
 *
 * Drop-in integration layer that adapts useMongoAuthState to the
 * existing session.js interface used by index.js.
 *
 * Usage in index.js:
 *
 *   import { getAuthState, clearSession, drainPendingDbWrites } from './src/auth/mongoSession.js';
 *
 *   // In shutdown():
 *   await drainPendingDbWrites();
 *
 * Environment variables required:
 *   MONGODB_URI    — e.g. mongodb+srv://user:pass@cluster.mongodb.net/dbname
 *   BOT_NUMBER     — e.g. 233503711391  (used as the session ID)
 *
 * Optional:
 *   MONGO_DB_NAME          — defaults to 'whatsapp_bot'
 *   MONGO_COLLECTION       — defaults to 'auth'
 *   MONGO_FLUSH_INTERVAL   — WAL debounce ms, defaults to 100
 *   MONGO_MAX_DIRTY_KEYS   — force-flush threshold, defaults to 100
 */

import { MongoClient } from 'mongodb';
import { useMongoAuthState } from './useMongoAuthState.js';
import { ensureMongoIndexes }  from './mongoSetup.js';
import { botConfig }           from '../config.js';

// Required credential fields for a fully-provisioned session.
// Missing ANY of these means the session is corrupt and must be wiped.
const REQUIRED_CRED_FIELDS = [
  'noiseKey',
  'signedIdentityKey',
  'registrationId',
  'signedPreKey',
  'me',
];

// ─── MongoDB connection (singleton) ───────────────────────────────────────────

let _client = null;
let _db     = null;

async function getDb() {
  if (_db) return _db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set. Add it as a Koyeb environment variable.');

  _client = new MongoClient(uri, {
    maxPoolSize:    10,
    minPoolSize:    2,
    connectTimeoutMS: 15_000,
    socketTimeoutMS:  30_000,
    serverSelectionTimeoutMS: 15_000,
  });

  await _client.connect();

  const dbName = process.env.MONGO_DB_NAME || 'whatsapp_bot';
  _db = _client.db(dbName);

  _client.on('error', (err) =>
    console.error('[MongoDB] Connection error (non-fatal):', err.message)
  );

  console.log('[MongoDB] Connected to:', dbName);

  return _db;
}

// ─── Auth state instance (singleton per session) ──────────────────────────────

let _authInstance = null;

function _getSessionIdPrivate() {
  const id = botConfig.BOT_NUMBER || process.env.BOT_NUMBER;
  if (!id) {
    throw new Error(
      'BOT_NUMBER is not set. Add it as a Koyeb environment variable. ' +
      'Without it, session keys are stored under the wrong prefix.'
    );
  }
  return id;
}

// ─── Public API (mirrors existing session.js exports) ────────────────────────

/**
 * Returns the Baileys-compatible { state, saveCreds } pair.
 * First call bootstraps from MongoDB; subsequent calls return the cached instance.
 */
export async function getAuthState() {
  if (_authInstance) return _authInstance;

  const db        = await getDb();
  const sessionId = _getSessionIdPrivate();

  const collectionName = process.env.MONGO_COLLECTION  || 'auth';
  // Decreased flush interval to 10ms to prevent session loss on abrupt kills
  const flushIntervalMs = parseInt(process.env.MONGO_FLUSH_INTERVAL || '10', 10);
  const maxDirtyKeys    = parseInt(process.env.MONGO_MAX_DIRTY_KEYS  || '100', 10);

  // Create indexes on first boot (idempotent — safe to run every time)
  await ensureMongoIndexes(db, collectionName);

  _authInstance = await useMongoAuthState(db, sessionId, {
    flushIntervalMs,
    maxDirtyKeys,
    collection: collectionName,
  });

  // Integrity check: if creds exist but are missing any critical field,
  // self-heal by wiping the session so a fresh QR scan is triggered.
  // Checking all REQUIRED_CRED_FIELDS prevents partial sessions that would
  // connect but immediately throw Bad MAC / cryptographic errors.
  const { creds } = _authInstance.state;
  if (creds && Object.keys(creds).length > 0) {
    const missingFields = REQUIRED_CRED_FIELDS.filter((f) => !creds[f]);
    if (missingFields.length > 0) {
      console.warn(
        `[MongoAuth] Session '${sessionId}' is incomplete (missing: ${missingFields.join(', ')}). ` +
        `Self-healing: clearing session.`
      );
      await clearSession();
      // Re-initialize with a fresh state
      _authInstance = await useMongoAuthState(db, sessionId, {
        flushIntervalMs,
        maxDirtyKeys,
        collection: collectionName,
      });
    }
  }

  if (!creds?.noiseKey) {
    console.log(`[MongoAuth] No session found for '${sessionId}' — QR login required`);
  }

  return _authInstance;
}

/**
 * Drain the WAL and flush all pending writes to MongoDB.
 * Call this in SIGTERM/SIGINT handlers before process.exit().
 */
export async function drainPendingDbWrites() {
  if (!_authInstance) return;
  await _authInstance.flushNow();
  console.log('[MongoAuth] WAL drained on shutdown.');
}

// Alias for backward compatibility with index.js
export { drainPendingDbWrites as drainPendingDbWritesMongo };

/**
 * Purge a single corrupt Signal key from L1, WAL, and MongoDB.
 * Called by badMacInterceptor when a Bad MAC decryption error occurs.
 * This prevents the same corrupt key from causing repeated errors.
 *
 * @param {string} type - Baileys key type (e.g. 'session', 'pre-key')
 * @param {string} id   - Key ID within that type
 */
export async function purgeCorruptKey(type, id) {
  if (!_authInstance) return;
  await _authInstance.purgeCorruptKey(type, id);
}

/**
 * Returns the active session ID (BOT_NUMBER).
 * Exposed so badMacInterceptor can include it in log messages.
 */
export function getSessionId() {
  return botConfig.BOT_NUMBER || process.env.BOT_NUMBER || 'unknown';
}

/**
 * Clear the entire session from L1 and MongoDB.
 * Only call this on 401 loggedOut — NEVER on 500 badSession.
 */
export async function clearSession() {
  if (_authInstance) {
    await _authInstance.clearSession();
    _authInstance = null;
  } else {
    // No in-memory instance — wipe MongoDB directly
    const db        = await getDb();
    const sessionId = _getSessionIdPrivate();
    const col = db.collection(process.env.MONGO_COLLECTION || 'auth');
    await col.deleteMany({ _id: { $regex: `^${sessionId}:` } });
    console.log(`[MongoAuth] Session '${sessionId}' cleared from MongoDB.`);
  }
}

/**
 * Close the MongoDB connection. Call this after process.exit() is imminent.
 */
export async function closeMongoConnection() {
  if (_client) {
    await _client.close();
    _client = null;
    _db     = null;
    console.log('[MongoDB] Connection closed.');
  }
}

// ─── Legacy stubs ────────────────────────────────────────────────────────────

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === 'true') {
    console.log('[MongoAuth] FORCE_FRESH_SESSION — clearing all keys');
    await clearSession();
  }
  return true;
}

export async function saveSession() {
  // No-op: useMongoAuthState handles persistence via WAL automatically
}
