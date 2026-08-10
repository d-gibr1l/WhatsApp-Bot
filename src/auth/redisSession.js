/**
 * redisSession.js
 *
 * Drop-in integration layer that adapts ioredis to the
 * existing session interface.
 */

import Redis from 'ioredis';
import { initAuthCreds, proto, BufferJSON } from '@whiskeysockets/baileys';
import { botConfig } from '../config.js';

let _redis = null;
let _authInstance = null;
let _authPromise = null;
let _authGeneration = 0;
const _l1Cache = new Map();
const L1_MAX = 2000;
const KEY_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

const _pendingWrites = new Set();
const _purgedKeys = new Map();
const PURGED_KEY_TTL_MS = 10_000;
const PURGED_KEYS_MAX = 500;

function markKeyPurged(key) {
  _l1Cache.delete(key);
  if (_purgedKeys.size >= PURGED_KEYS_MAX) {
    const oldest = _purgedKeys.keys().next().value;
    _purgedKeys.delete(oldest);
  }
  _purgedKeys.set(key, Date.now());
}

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
  tracked.catch(() => {});
  return promise;
}

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

const REQUIRED_CRED_FIELDS = [
  'noiseKey',
  'signedIdentityKey',
  'registrationId',
  'signedPreKey',
];

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
      `purge and wipe at an empty keyspace.`
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

  if (!_sweepTimer) {
    _sweepTimer = setInterval(sweepPurgedKeys, 30_000);
    _sweepTimer.unref?.();
  }

  return _redis;
}

// Optimized Buffer Reviver with fast-path key inspection
const bufferReviver = (keyName, value) => {
  const revived = BufferJSON.reviver(keyName, value);
  if (revived !== value) return revived;
  
  // Fast-path: Only inspect plain objects that actually have numeric key '0'
  if (value && typeof value === 'object' && !Array.isArray(value) && value[0] !== undefined) {
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

function normalizeForType(value, keyType) {
  if (keyType === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
}

export async function getAuthState() {
  if (_authInstance) return _authInstance;
  if (_authPromise) return _authPromise;
  _authPromise = _buildAuthState().finally(() => { _authPromise = null; });
  return _authPromise;
}

async function _buildAuthState() {
  const redis = getRedis();
  const sessionId = getSessionId();
  const generation = _authGeneration;

  const credsKey = `${sessionId}:creds`;
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
      `[RedisAuth] Session '${sessionId}' is corrupt (${reason}). Self-healing: clearing session keys.`
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
      const resultsToL1 = [];

      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
          const key = `${sessionId}:${category}-${id}`;
          const value = data[category][id];
          if (value) {
            _purgedKeys.delete(key);
            const val = normalizeForType(value, category);
            resultsToL1.push(l1Updates.length);
            l1Updates.push({ key, val });
            
            l1Set(key, val);
            pipeline.set(key, serialize(value), 'EX', KEY_TTL_SECONDS);
          } else {
            resultsToL1.push(-1);
            l1Deletes.push(key);
            
            _l1Cache.delete(key);
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
          const failedL1 = new Set();
          for (let ri = 0; ri < results.length; ri++) {
            if (results[ri][0] && resultsToL1[ri] >= 0) {
              failedL1.add(resultsToL1[ri]);
            }
          }
          for (let i = 0; i < l1Updates.length; i++) {
            if (failedL1.has(i)) {
              _l1Cache.delete(l1Updates[i].key);
            }
          }
        }
      } catch (err) {
        console.error('[RedisAuth] Failed to execute keys.set pipeline:', err.message);
        for (let i = 0; i < l1Updates.length; i++) {
          _l1Cache.delete(l1Updates[i].key);
        }
      }
    }
  };

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

  if (generation !== _authGeneration) {
    instance.invalidate();
    console.warn(
      `[RedisAuth] Session '${sessionId}' was cleared while auth state was loading — discarding stale instance.`
    );
    return instance;
  }

  _authInstance = instance;
  return instance;
}

async function _wipeSessionKeys(redis, sessionId) {
  _l1Cache.clear();
  const keys = await scanKeys(redis, `${sessionId}:*`);
  for (const k of keys) {
    markKeyPurged(k);
  }
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

  const client = _redis;
  _redis = null;

  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }

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

  const isGroup = jid.endsWith('@g.us');
  const userJid = isGroup ? jid : jid.split('@')[0];
  const base = escapeGlob(isGroup ? jid : userJid.split(':')[0].split('.')[0]);

  const patterns = isGroup
    ? [
        `${sessionId}:sender-key-${base}::*`,
        `${sessionId}:sender-key-memory-${base}`,
      ]
    : [
        `${sessionId}:session-${base}.*`,
        `${sessionId}:sender-key-*::${base}::*`,
      ];

  const results = await Promise.all(patterns.map(p => scanKeys(redis, p)));
  const keysToDelete = [...new Set(results.flat())];

  if (keysToDelete.length > 0) {
    for (const key of keysToDelete) {
      markKeyPurged(key);
    }
    const BATCH = 500;
    for (let i = 0; i < keysToDelete.length; i += BATCH) {
      const pipeline = redis.pipeline();
      for (const k of keysToDelete.slice(i, i + BATCH)) pipeline.del(k);
      await pipeline.exec();
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

export async function saveSession() {}
