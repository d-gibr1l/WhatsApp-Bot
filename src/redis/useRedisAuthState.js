import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { Mutex } from "async-mutex";
import { deflateSync, inflateSync } from "zlib";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" }).child({ module: "RedisAuthState" });

export const useRedisAuthState = async (sessionId, redisClient) => {
  const SESSION_PREFIX = `whatsapp:session:${sessionId}`;
  const credsKey = `${SESSION_PREFIX}:creds`;
  const keysKey = `${SESSION_PREFIX}:keys`;

  const writeMutex = new Mutex();

  // Helper to read and decode data
  const readData = async (key, decompress = false) => {
    try {
      const raw = await redisClient.get(key);
      if (!raw) return null;
      let dataStr = raw;
      if (decompress) {
        const buffer = Buffer.from(raw, "base64");
        dataStr = inflateSync(buffer).toString("utf-8");
      }
      return JSON.parse(dataStr, BufferJSON.reviver);
    } catch (error) {
      logger.error({ sessionId, key, error: error.message }, "Failed to read or parse Redis data");
      return null;
    }
  };

  // Helper to write and encode data safely
  const writeData = async (key, data, compress = false) => {
    try {
      const dataStr = JSON.stringify(data, BufferJSON.replacer);
      let payload = dataStr;
      if (compress) {
        payload = deflateSync(Buffer.from(dataStr, "utf-8")).toString("base64");
      }
      await redisClient.set(key, payload);
    } catch (error) {
      logger.error({ sessionId, key, error: error.message }, "Failed to serialize or write to Redis");
    }
  };

  const removeData = async (key) => {
    try {
      await redisClient.del(key);
    } catch (error) {
      logger.error({ sessionId, key, error: error.message }, "Failed to delete from Redis");
    }
  };

  const credsBackupKey = `${SESSION_PREFIX}:creds_backup`;

  // 1. Initialize or load creds
  let creds = await readData(credsKey, false);
  if (!creds) {
    // Attempt recovery from backup if corruption detected
    let backupCreds = await readData(credsBackupKey, false);
    if (backupCreds) {
       creds = backupCreds;
       await writeData(credsKey, creds, false);
       logger.warn({ sessionId }, "Restored auth creds from backup due to corruption or absence");
    } else {
       creds = initAuthCreds();
       await writeData(credsKey, creds, false);
       logger.info({ sessionId }, "Created new auth creds");
    }
  } else {
    logger.info({ sessionId }, "Loaded existing auth creds");
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const fieldId = `${type}-${id}`;
              let value = await readData(`${keysKey}:${fieldId}`, true);
              if (value) {
                if (type === "app-state-sync-key" && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
              }
            })
          );
          return data;
        },
        set: async (data) => {
          // Prevent concurrent writes to Redis
          const release = await writeMutex.acquire();
          try {
            const pipeline = redisClient.pipeline();
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const fieldId = `${category}-${id}`;
                const key = `${keysKey}:${fieldId}`;
                if (value) {
                  const dataStr = JSON.stringify(value, BufferJSON.replacer);
                  const payload = deflateSync(Buffer.from(dataStr, "utf-8")).toString("base64");
                  pipeline.set(key, payload);
                } else {
                  pipeline.del(key);
                }
              }
            }
            await pipeline.exec();
          } catch (error) {
             logger.error({ sessionId, error: error.message }, "Failed to set keys in Redis");
          } finally {
            release();
          }
        },
      },
    },
    saveCreds: async () => {
      const release = await writeMutex.acquire();
      try {
        // Backup last valid creds before overwrite
        const lastValid = await readData(credsKey, false);
        if (lastValid) {
            await writeData(credsBackupKey, lastValid, false);
        }
        await writeData(credsKey, creds, false);
      } finally {
        release();
      }
    },
    clearState: async () => {
      const release = await writeMutex.acquire();
      try {
        const keys = await redisClient.keys(`${SESSION_PREFIX}:*`);
        if (keys.length > 0) {
          await redisClient.del(...keys);
        }
        logger.info({ sessionId }, "Cleared auth state");
      } catch (error) {
        logger.error({ sessionId, error: error.message }, "Failed to clear state");
      } finally {
        release();
      }
    }
  };
};
