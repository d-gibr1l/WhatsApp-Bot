/**
 * redisSession.js
 *
 * Drop-in integration layer that adapts ioredis to the
 * existing session.js interface used by index.js.
 *
 * Usage in index.js:
 *
 *   import { getAuthState, clearSession, drainPendingDbWrites } from './src/auth/redisSession.js';
 */

import Redis from 'ioredis';
import { initAuthCreds, proto, BufferJSON } from '@whiskeysockets/baileys';
import { botConfig } from '../config.js';

let _redis = null;
let _authInstance = null;
let _authPromise = null;
// Bumped by clearSession(). An in-flight _buildAuthState() compares against it
// before publishing, so a build that started before the clear cannot install
// itself afterwards and resurrect the session that was just wiped.
let _authGeneration = 0;
const _l1Cache = new Map();
const L1_MAX = 2000;
const KEY_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

// Redis writes that have been issued but not yet acknowledged, so
// drainPendingDbWrites() can actually wait for them before shutdown.
const _pendingWrites = new Set();
const _purgedKeys = new Map(); // Map<key, timestampMs>
const PURGED_KEY_TTL_MS = 10_000;
const PURGED_KEYS_MAX = 500;

function markKeyPurged(key) {
  _l1Cache.delete(key);
  // Cap the purged-keys map to prevent unbounded growth during Bad MAC storms.
  // Evict the oldest entry when at capacity.
  if (_purgedKeys.size >= PURGED_KEYS_MAX) {
    const oldest = _purgedKeys.keys().next().value;
    _purgedKeys.delete(oldest);
  }
  _purgedKeys.set(key, Date.now());
}

// Periodic sweep of expired purged keys — called from a single setInterval
// rather than spawning a setTimeout per key.
function sweepPurgedKeys() {
  const now = Date.now();
  for (const [key, ts] of _purgedKeys.entries()) {
    if (now - ts > PURGED_KEY_TTL_MS) {
      _purgedKeys.delete(key);
    }
  }
}

function trackWrite(promise) {
  let tracked;
  tracked = promise.finally(() => _pendingWrites.delete(tracked));
  _pendingWrites.add(tracked);
  // The caller still owns error handling for `promise`; this derived copy
  // exists only for drain bookkeeping, so swallow to avoid reporting the same
  // failure twice as an unhandled rejection.
  tracked.catch(() => {});
  return promise;
}

// Redis MATCH treats these as glob metacharacters. JIDs should never contain
// them, but the value reaches us via a parsed error stack, so escape it rather
// than trust the shape.
const escapeGlob = (s) => s.replace(/[*?[\]\\]/g, '\\$&');

function l1Set(key, value) {
  _l1Cache.delete(key);
  if (_l1Cache.size >= L1_MAX) {
    _l1Cache.delete(_l1Cache.keys().next().value);
  }
  _l1Cache.set(key, value);
}

async function scanKeys(redis, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== '0');
  return keys;
}

// Core cryptographic material that initAuthCreds() populates up front. A
// persisted blob missing any of these is unusable and must be wiped.
//
// `me` is deliberately NOT listed: initAuthCreds() never sets it and Baileys
// only fills it in once pairing completes, so treating it as required would
// condemn every session that is still mid-QR-scan. Pairing progress is
// reported separately in _buildAuthState().
const REQUIRED_CRED_FIELDS = [
  'noiseKey',
  'signedIdentityKey',
  'registrationId',
  'signedPreKey',
];

// The Redis keyspace namespace. Resolved once, on first use, then frozen.
//
// It deliberately does NOT track botConfig.BOT_NUMBER over time. That value is
// only populated once connection.update fires "open" (index.js), but the auth
// state must be read from Redis *before* connecting — the creds are what you
// authenticate with, so the number cannot be known first. The dependency is
// circular and unresolvable.
//
// Letting the namespace change mid-process is what makes it dangerous:
// _buildAuthState() captures it once and keeps writing under the original
// prefix, while purgeCorruptKey(), purgeAllKeysForJid() and clearSession()
// each re-resolve it per call. After the number is detected those two diverge,
// so every purge and every wipe silently targets an empty keyspace — Bad MAC
// self-heal stops healing, and /api/system/wipe stops wiping.
let _sessionId = null;
let _warnedUnknownNs = false;
let _warnedNsDrift = false;

export function getSessionId() {
  if (_sessionId === null) {
    _sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || 'unknown';
    if (_sessionId === 'unknown' && !_warnedUnknownNs) {
      _warnedUnknownNs = true;
      console.warn(
        `[RedisAuth] BOT_NUMBER is unset — pinning the keyspace to 'unknown'. ` +
        `Set BOT_NUMBER in the environment if more than one bot shares this Redis.`
      );
    }
    return _sessionId;
  }

  const live = botConfig.BOT_NUMBER || process.env.BOT_NUMBER;
  if (live && live !== _sessionId && !_warnedNsDrift) {
    _warnedNsDrift = true;
    console.warn(
      `[RedisAuth] BOT_NUMBER resolved to '${live}' after the keyspace was pinned ` +
      `to '${_sessionId}'. Keeping '${_sessionId}': switching now would point every ` +
      `purge and wipe at an empty keyspace. Set BOT_NUMBER at startup to pin it ` +
      `explicitly.`
    );
  }
  return _sessionId;
}

let _sweepTimer = null;

function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  _redis = new Redis(url);
  _redis.on('error', err => console.error('[RedisAuth] Error:', err.message));
  _redis.on('ready', () => console.log('[RedisAuth] Connected'));

  // Start a single periodic sweep for expired purged keys.
  if (!_sweepTimer) {
    _sweepTimer = setInterval(sweepPurgedKeys, 30_000);
    _sweepTimer.unref?.();
  }

  return _redis;
}

const bufferReviver = (keyName, value) => {
  const revived = BufferJSON.reviver(keyName, value);
  if (revived !== value) return revived;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      keys.length > 0 &&
      keys.every((k, i) => k === String(i) && typeof value[k] === 'number' && Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 255)
    ) {
      const arr = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        arr[i] = value[i];
      }
      return Buffer.from(arr);
    }
  }
  return value;
};

const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (raw, keyType) => {
  if (!raw) return null;
  const value = JSON.parse(raw, bufferReviver);
  return normalizeForType(value, keyType);
};

// Ensure a value has the same shape whether it came from Redis (read path) or
// straight from Baileys (write path). Baileys hands us a plain object for
// app-state-sync-key on set, but expects the proto form on get — so the L1
// cache must store the proto form in both cases to stay consistent.
function normalizeForType(value, keyType) {
  if (keyType === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
}

export async function getAuthState() {
  if (_authInstance) return _authInstance;
  // Guard against concurrent callers building two instances during startup.
  if (_authPromise) return _authPromise;
  _authPromise = _buildAuthState().finally(() => { _authPromise = null; });
  return _authPromise;
}

async function _buildAuthState() {
  const redis = getRedis();
  const sessionId = getSessionId();
  const generation = _authGeneration;

  const credsKey = `${sessionId}:creds`;

  // True once creds have actually been read back from Redis. Only a persisted
  // blob can be corrupt — a freshly initialised one is complete by construction.
  let hadPersistedCreds = false;

  const writeCreds = async (creds) => {
    await trackWrite(redis.set(credsKey, serialize(creds), 'EX', KEY_TTL_SECONDS));
  };

  let creds;
  let rawCredsExisted = false;
  try {
    const raw = await redis.get(credsKey);
    if (raw) {
      rawCredsExisted = true;
      creds = deserialize(raw, 'creds');
      hadPersistedCreds = true;
    } else {
      creds = initAuthCreds();
    }
  } catch (err) {
    console.warn('[RedisAuth] Could not read or parse creds from Redis, starting fresh:', err.message);
    creds = initAuthCreds();
  }

  const checkIntegrity = async () => {
    const isCorruptBlob = rawCredsExisted && !hadPersistedCreds;
    const missingFields =
      !creds || typeof creds !== 'object'
        ? ['<unreadable creds blob>']
        : REQUIRED_CRED_FIELDS.filter((f) => creds[f] === undefined || creds[f] === null);

    const isMissingRequired = hadPersistedCreds && missingFields.length > 0;

    if (!isCorruptBlob && !isMissingRequired) return;

    const reason = isCorruptBlob
      ? 'unparseable creds blob'
      : `missing required fields: ${missingFields.join(', ')}`;

    console.warn(
      `[RedisAuth] Session '${sessionId}' is corrupt (${reason}). ` +
      `Self-healing: clearing session keys.`
    );
    await _wipeSessionKeys(redis, sessionId);
    creds = initAuthCreds();
    hadPersistedCreds = false;
  };

  await checkIntegrity();

  if (!hadPersistedCreds) {
    console.log(`[RedisAuth] No session found for '${sessionId}' — QR login required`);
  } else if (!creds.me) {
    console.log(
      `[RedisAuth] Session '${sessionId}' restored but pairing never completed — resuming QR login`
    );
  }

  // Flipped by clearSession() when this instance is discarded. A socket can
  // outlive the clear and keep emitting creds.update / key writes; those must
  // not resurrect the session we just wiped.
  let stale = false;

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const pipeline = redis.pipeline();
      const keysToFetch = [];

      for (const id of ids) {
        const key = `${sessionId}:${type}-${id}`;
        if (_l1Cache.has(key)) {
          const val = _l1Cache.get(key);
          _l1Cache.delete(key);
          _l1Cache.set(key, val);
          data[id] = val;
        } else {
          pipeline.get(key);
          keysToFetch.push({ id, key });
        }
      }

      if (keysToFetch.length > 0) {
        try {
          const results = await pipeline.exec();
          if (results) {
            for (let i = 0; i < keysToFetch.length; i++) {
              const { id, key } = keysToFetch[i];
              const [err, raw] = results[i];
              if (err) {
                console.error(`[RedisAuth] Error fetching key ${key}:`, err);
                continue;
              }
              if (raw && !stale && !_purgedKeys.has(key)) {
                try {
                  const parsed = deserialize(raw, type);
                  l1Set(key, parsed);
                  data[id] = parsed;
                } catch (parseErr) {
                  console.warn(`[RedisAuth] Corrupted data for key ${key}, skipping:`, parseErr.message);
                }
              }
            }
          }
        } catch (err) {
          console.error(`[RedisAuth] Pipeline error in keys.get:`, err.message);
        }
      }
      return data;
    },
    set: async (data) => {
      if (stale) return;
      const pipeline = redis.pipeline();
      const l1Updates = [];
      const l1Deletes = [];

      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
          const key = `${sessionId}:${category}-${id}`;
          const value = data[category][id];
          if (value) {
            _purgedKeys.delete(key);
            const val = normalizeForType(value, category);
            l1Updates.push({ key, val });
            pipeline.set(key, serialize(value), 'EX', KEY_TTL_SECONDS);
          } else {
            l1Deletes.push(key);
            pipeline.del(key);
          }
        }
      }

      if (l1Updates.length === 0 && l1Deletes.length === 0) return;

      try {
        const results = await trackWrite(pipeline.exec());
        const errors = results ? results.filter(([err]) => err) : [];
        if (errors.length > 0) {
          console.error(`[RedisAuth] ${errors.length} errors during keys.set pipeline execution`, errors[0][0]);
          // Roll back L1 for any key whose Redis write failed, so L1 stays
          // consistent with what Redis actually persisted.
          const failedIndices = new Set(
            errors.map(([, , idx]) => idx).filter((i) => i !== undefined)
          );
          for (let i = 0; i < l1Updates.length; i++) {
            if (failedIndices.size === 0 || failedIndices.has(i)) {
              // Re-apply successful writes; evict failed ones.
              if (failedIndices.has(i)) {
                _l1Cache.delete(l1Updates[i].key);
              } else {
                l1Set(l1Updates[i].key, l1Updates[i].val);
              }
            } else {
              l1Set(l1Updates[i].key, l1Updates[i].val);
            }
          }
        } else {
          // All writes confirmed — commit L1 updates now.
          for (const { key, val } of l1Updates) l1Set(key, val);
          for (const key of l1Deletes) _l1Cache.delete(key);
        }
      } catch (err) {
        console.error('[RedisAuth] Failed to execute keys.set pipeline:', err.message);
        // Pipeline threw — don't commit L1; treat the batch as a no-op.
      }
    }
  };

  // Bound to a local rather than read back off the module-level _authInstance,
  // which clearSession() sets to null while this instance may still be in use.
  const instance = {
    state: { creds, keys },
    saveCreds: async () => {
      if (stale) {
        console.warn(
          `[RedisAuth] Ignoring saveCreds for cleared session '${sessionId}' — ` +
          `call getAuthState() again to rebuild auth state.`
        );
        return;
      }
      await writeCreds(instance.state.creds);
    },
    invalidate: () => { stale = true; }
  };

  // clearSession() may have run while we were reading from Redis. This instance
  // describes a session that no longer exists, so hand it back to the caller
  // already invalidated rather than publishing it as the live one — the next
  // getAuthState() then builds cleanly against the wiped session.
  if (generation !== _authGeneration) {
    instance.invalidate();
    console.warn(
      `[RedisAuth] Session '${sessionId}' was cleared while auth state was loading — ` +
      `discarding the stale instance.`
    );
    return instance;
  }

  _authInstance = instance;
  return instance;
}

// Deletes every key for the session without touching the cached auth instance
// or the generation counter. _buildAuthState()'s self-heal path needs this:
// it is *part of* the build, so bumping the generation would make the build
// invalidate the very instance it is about to return.
async function _wipeSessionKeys(redis, sessionId) {
  _l1Cache.clear();
  const keys = await scanKeys(redis, `${sessionId}:*`);
  for (const k of keys) {
    markKeyPurged(k);
  }
  // Use a pipeline instead of spread-del so we never hit Node's argument-count
  // limit or Redis's max inline-command size, regardless of how many keys exist.
  const BATCH = 500;
  for (let i = 0; i < keys.length; i += BATCH) {
    const pipeline = redis.pipeline();
    for (const k of keys.slice(i, i + BATCH)) pipeline.del(k);
    await pipeline.exec();
  }
}

export async function clearSession() {
  const redis = getRedis();
  const sessionId = getSessionId();
  _authGeneration++;
  const previous = _authInstance;
  _authInstance = null;
  _authPromise = null;
  previous?.invalidate();
  await _wipeSessionKeys(redis, sessionId);
  console.log(`[RedisAuth] Session '${sessionId}' cleared.`);
}

export async function drainPendingDbWrites() {
  // There is no write-ahead log — keys.set/saveCreds write through to Redis
  // immediately — but "issued" is not "acknowledged". Anything still in flight
  // would be lost when closeRedisConnection() runs, so wait it out here.
  if (_pendingWrites.size === 0) {
    console.log('[RedisAuth] No pending writes to drain.');
    return;
  }
  const pending = _pendingWrites.size;
  await Promise.allSettled([..._pendingWrites]);
  console.log(`[RedisAuth] Drained ${pending} pending write(s).`);
}

export async function closeRedisConnection() {
  if (!_redis) return;

  // Capture the client reference before nulling the module-level variable.
  // If quit() times out, the .catch() fallback calls disconnect() on the
  // captured reference — without this, _redis would already be null.
  const client = _redis;
  _redis = null;

  // Stop the purged-keys sweep timer.
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }

  // The cached auth instance closed over this client. Leaving it published
  // would hand later callers an instance whose writes go to a quit connection,
  // so retire it and let the next getAuthState() rebuild against a fresh one.
  const previous = _authInstance;
  _authInstance = null;
  _authPromise = null;
  previous?.invalidate();

  await Promise.race([
    client.quit(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), 3000))
  ]).catch(() => client.disconnect());
  console.log('[RedisAuth] Connection closed.');
}

export async function purgeCorruptKey(type, id) {
  const redis = getRedis();
  const sessionId = getSessionId();
  const key = `${sessionId}:${type}-${id}`;
  markKeyPurged(key);
  await redis.del(key);
  console.log(`[RedisAuth] Purged corrupt key: ${key}`);
}

export async function purgeAllKeysForJid(jid) {
  const redis = getRedis();
  const sessionId = getSessionId();

  // A group jid must be kept whole — sender-key ids embed the full "<n>@g.us",
  // and splitting on '.' would truncate it to "<n>@g".
  const isGroup = jid.endsWith('@g.us');
  const userJid = isGroup ? jid : jid.split('@')[0];
  const base = escapeGlob(isGroup ? jid : userJid.split(':')[0].split('.')[0]);

  // Key id formats, verified against Baileys 6.7.21:
  //   session            "<user>.<device>"            (ProtocolAddress.toString)
  //   sender-key         "<group>::<user>::<device>"  (SenderKeyName.toString)
  //   sender-key-memory  "<group>"                    (the group jid itself)
  // A user id never contains '.' or '_': ProtocolAddress rejects a dotted id,
  // and jidDecode() strips any "_agent" before the address is built.
  //
  // Every pattern is anchored on the separator that terminates the user/group
  // part. A bare `${base}*` also matches any longer id sharing those leading
  // digits, so purging '123456' would wipe '1234567's keys along with it.
  const patterns = isGroup
    ? [
        `${sessionId}:sender-key-${base}::*`,      // <group>::<user>::<device>
        `${sessionId}:sender-key-memory-${base}`,  // id is the group jid itself
      ]
    : [
        `${sessionId}:session-${base}.*`,          // <user>.<device>
        `${sessionId}:sender-key-*::${base}::*`,   // this user's key in any group
      ];

  const results = await Promise.all(patterns.map(p => scanKeys(redis, p)));
  // SCAN may return the same key more than once, and patterns can overlap.
  const keysToDelete = [...new Set(results.flat())];

  if (keysToDelete.length > 0) {
    for (const key of keysToDelete) {
      markKeyPurged(key);
    }
    const BATCH = 500;
    for (let i = 0; i < keysToDelete.length; i += BATCH) {
      await redis.del(...keysToDelete.slice(i, i + BATCH));
    }
    console.log(`[RedisAuth] Circuit Breaker: Purged ${keysToDelete.length} keys for JID ${base}`);
  }
}

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === 'true') {
    console.log('[RedisAuth] FORCE_FRESH_SESSION — clearing all keys');
    await clearSession();
  }
  return true;
}

// saveSession is a no-op stub kept for interface compatibility with index.js.
// All persistence happens eagerly inside keys.set and saveCreds — there is no
// deferred flush step to trigger here.
export async function saveSession() {}
