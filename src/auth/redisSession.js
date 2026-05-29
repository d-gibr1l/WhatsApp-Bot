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

  // L1 memory cache for keys
  const l1Cache = new Map();

  const readCreds = async () => {
    const raw = await redis.get(credsKey);
    return raw ? deserialize(raw, 'creds') : initAuthCreds();
  };

  const writeCreds = async (creds) => {
    await redis.set(credsKey, serialize(creds));
  };

  let creds = await readCreds();

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
        if (l1Cache.has(key)) {
          data[id] = l1Cache.get(key);
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
          if (!err && raw) {
            const parsed = deserialize(raw, type);
            l1Cache.set(key, parsed);
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
            l1Cache.set(key, value);
            pipeline.set(key, serialize(value));
          } else {
            l1Cache.delete(key);
            pipeline.del(key);
          }
        }
      }
      await pipeline.exec();
    }
  };

  _authInstance = {
    state: { creds, keys },
    saveCreds: async () => {
      await writeCreds(creds);
    }
  };

  return _authInstance;
}

export async function clearSession() {
  const redis = getRedis();
  const sessionId = getSessionId();
  if (_authInstance) {
    _authInstance.state.creds = initAuthCreds();
  }
  const keys = await redis.keys(`${sessionId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  console.log(`[RedisAuth] Session '${sessionId}' cleared.`);
}

export async function drainPendingDbWrites() {
  console.log('[RedisAuth] No WAL to drain. Writes are synchronous.');
}

export async function closeRedisConnection() {
  if (_redis) {
    await _redis.quit();
    _redis = null;
    console.log('[RedisAuth] Connection closed.');
  }
}

export async function purgeCorruptKey(type, id) {
  const redis = getRedis();
  const sessionId = getSessionId();
  const key = `${sessionId}:${type}-${id}`;
  await redis.del(key);
  console.log(`[RedisAuth] Purged corrupt key: ${key}`);
}

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === 'true') {
    console.log('[RedisAuth] FORCE_FRESH_SESSION — clearing all keys');
    await clearSession();
  }
  return true;
}

export async function saveSession() {}
