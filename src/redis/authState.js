import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { Mutex } from 'async-mutex';
import { redisClient } from './client.js';
import { logger } from '../utils/logger.js';

// We map mutexes by session ID to prevent concurrent writes to the same session's creds
const sessionMutexes = new Map();

function getSessionMutex(sessionId) {
  if (!sessionMutexes.has(sessionId)) {
    sessionMutexes.set(sessionId, new Mutex());
  }
  return sessionMutexes.get(sessionId);
}

export const useRedisAuthState = async (sessionId) => {
  const credsKey = `whatsapp:session:${sessionId}:creds`;
  const keysKey = `whatsapp:session:${sessionId}:keys`;
  const mutex = getSessionMutex(sessionId);

  const readCreds = async () => {
    try {
      const data = await redisClient.get(credsKey);
      if (data) {
        return JSON.parse(data, BufferJSON.reviver);
      }
    } catch (err) {
      logger.error({ sessionId, err }, 'Failed to read creds from Redis');
    }
    return null;
  };

  const writeCreds = async (creds) => {
    return mutex.runExclusive(async () => {
      try {
        const data = JSON.stringify(creds, BufferJSON.replacer);
        await redisClient.set(credsKey, data);
      } catch (err) {
        logger.error({ sessionId, err }, 'Failed to write creds to Redis');
        throw err;
      }
    });
  };

  let creds = await readCreds();
  if (!creds) {
    creds = initAuthCreds();
    await writeCreds(creds);
  }

  const keys = {
    get: async (type, ids) => {
      const data = {};
      try {
        const fields = ids.map((id) => `${type}-${id}`);
        const values = await redisClient.hmget(keysKey, ...fields);

        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          let value = values[i];
          if (value) {
            value = JSON.parse(value, BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
          }
          data[id] = value;
        }
      } catch (err) {
        logger.error({ sessionId, type, err }, 'Failed to get keys from Redis');
      }
      return data;
    },
    set: async (data) => {
      try {
        const pipeline = redisClient.pipeline();

        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const field = `${category}-${id}`;

            if (value) {
              const strValue = JSON.stringify(value, BufferJSON.replacer);
              pipeline.hset(keysKey, field, strValue);
            } else {
              pipeline.hdel(keysKey, field);
            }
          }
        }
        await pipeline.exec();
      } catch (err) {
        logger.error({ sessionId, err }, 'Failed to set keys in Redis');
      }
    },
  };

  return {
    state: {
      creds,
      keys,
    },
    saveCreds: () => writeCreds(creds),
  };
};

export const clearSessionAuth = async (sessionId) => {
  const credsKey = `whatsapp:session:${sessionId}:creds`;
  const keysKey = `whatsapp:session:${sessionId}:keys`;
  const metaKey = `whatsapp:session:${sessionId}:meta`;
  const lockKey = `whatsapp:session:${sessionId}:lock`;
  const healthKey = `whatsapp:session:${sessionId}:health`;
  const retryKey = `whatsapp:session:${sessionId}:retry`;

  await redisClient.del(credsKey, keysKey, metaKey, lockKey, healthKey, retryKey);
  sessionMutexes.delete(sessionId);
};
