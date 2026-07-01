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
import { initAuthCreds, proto } from '@whiskeysockets/baileys';
import { botConfig } from '../config.js';

let _redis = null;
let _authInstance = null;
const _l1Cache = new Map();
const L1_MAX = 2000;
const KEY_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function l1Set(key, value) {
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

// Required credential fields for a fully-provisioned session.
// Missing ANY of these means the session is corrupt and must be wiped.
const REQUIRED_CRED_FIELDS = [
  'noiseKey',
  'signedIdentityKey',
  'registrationId',
  'signedPreKey',
  'me',
];

export function getSessionId() {
  return botConfig.BOT_NUMBER || process.env.BOT_NUMBER || 'unknown';
}

function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  _redis = new Redis(url);
  _redis.on('error', err => console.error('[RedisAuth] Error:', err.message));
  console.log('[RedisAuth] Connected');
  return _redis;
}

const bufferReviver = (keyName, value) => {
  if (value?.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
};

const serialize = (value) => JSON.stringify(value);
const deserialize = (raw, keyType) => {
  if (!raw) return null;
  const value = JSON.parse(raw, bufferReviver);
  if (keyType === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
};

export async function getAuthState() {
  if (_authInstance) return _authInstance;
  const redis = getRedis();
  const sessionId = getSessionId();

  const credsKey = `${sessionId}:creds`;

  const readCreds = async () => {
    const raw = await redis.get(credsKey);
    return raw ? deserialize(raw, 'creds') : initAuthCreds();
  };

  const writeCreds = async (creds) => {
    await redis.set(credsKey, serialize(creds), 'EX', KEY_TTL_SECONDS);
  };

  let creds;
  try {
    creds = await readCreds();
  } catch (err) {
    console.warn('[RedisAuth] Could not read creds from Redis, starting fresh:', err.message);
    creds = initAuthCreds();
  }

  const checkIntegrity = async () => {
    if (creds && Object.keys(creds).length > 0) {
      const missingFields = REQUIRED_CRED_FIELDS.filter((f) => !creds[f]);
      if (missingFields.length > 0) {
        console.warn(
          `[RedisAuth] Session '${sessionId}' is incomplete (missing: ${missingFields.join(', ')}). ` +
          `Self-healing: clearing session.`
        );
        await clearSession();
        creds = initAuthCreds();
      }
    }
  };

  await checkIntegrity();

  if (!creds?.noiseKey) {
    console.log(`[RedisAuth] No session found for '${sessionId}' — QR login required`);
  }

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const pipeline = redis.pipeline();
      const keysToFetch = [];

      for (const id of ids) {
        const key = `${sessionId}:${type}-${id}`;
        if (_l1Cache.has(key)) {
          data[id] = _l1Cache.get(key);
        } else {
          pipeline.get(key);
          keysToFetch.push({ id, key });
        }
      }

      if (keysToFetch.length > 0) {
        const results = await pipeline.exec();
        for (let i = 0; i < keysToFetch.length; i++) {
          const { id, key } = keysToFetch[i];
          const [err, raw] = results[i];
          if (err) {
            console.error(`[RedisAuth] Error fetching key ${key}:`, err);
            continue;
          }
          if (raw) {
            const parsed = deserialize(raw, type);
            _l1Cache.set(key, parsed);
            data[id] = parsed;
          }
        }
      }
      return data;
    },
    set: async (data) => {
      const pipeline = redis.pipeline();
      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
          const key = `${sessionId}:${category}-${id}`;
          const value = data[category][id];
          if (value) {
            l1Set(key, value);
            pipeline.set(key, serialize(value), 'EX', KEY_TTL_SECONDS);
          } else {
            _l1Cache.delete(key);
            pipeline.del(key);
          }
        }
      }
      const results = await pipeline.exec();
      const errors = results.filter(([err]) => err);
      if (errors.length > 0) {
        console.error(`[RedisAuth] ${errors.length} errors during keys.set pipeline execution`, errors[0][0]);
      }
    }
  };

  _authInstance = {
    state: { creds, keys },
    saveCreds: async () => {
      await writeCreds(_authInstance.state.creds);
    }
  };

  return _authInstance;
}

export async function clearSession() {
  const redis = getRedis();
  const sessionId = getSessionId();
  _authInstance = null;
  _l1Cache.clear();
  const keys = await scanKeys(redis, `${sessionId}:*`);
  if (keys.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < keys.length; i += BATCH) {
      await redis.del(...keys.slice(i, i + BATCH));
    }
  }
  console.log(`[RedisAuth] Session '${sessionId}' cleared.`);
}

export async function drainPendingDbWrites() {
  console.log('[RedisAuth] No WAL to drain. Writes are synchronous.');
}

export async function closeRedisConnection() {
  if (_redis) {
    await Promise.race([
      _redis.quit(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), 3000))
    ]).catch(() => _redis.disconnect());
    _redis = null;
    console.log('[RedisAuth] Connection closed.');
  }
}

export async function purgeCorruptKey(type, id) {
  const redis = getRedis();
  const sessionId = getSessionId();
  const key = `${sessionId}:${type}-${id}`;
  _l1Cache.delete(key);
  await redis.del(key);
  console.log(`[RedisAuth] Purged corrupt key: ${key}`);
}

export async function purgeAllKeysForJid(jid) {
  const redis = getRedis();
  const sessionId = getSessionId();
  const baseJid = jid.split(':')[0].split('.')[0]; 
  
  const patterns = [
    `${sessionId}:session-${baseJid}*`,
    `${sessionId}:sender-key-${baseJid}*`,
    `${sessionId}:sender-key-memory-${baseJid}*`
  ];

  const results = await Promise.all(patterns.map(p => scanKeys(redis, p)));
  const keysToDelete = results.flat();

  if (keysToDelete.length > 0) {
    for (const key of keysToDelete) {
      _l1Cache.delete(key);
    }
    const BATCH = 500;
    for (let i = 0; i < keysToDelete.length; i += BATCH) {
      await redis.del(...keysToDelete.slice(i, i + BATCH));
    }
    console.log(`[RedisAuth] Circuit Breaker: Purged ${keysToDelete.length} keys for JID ${baseJid}`);
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
