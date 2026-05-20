import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { mutex } from '../utils/mutex.js';

export const useRedisAuthState = async (redis, sessionId) => {
  const getKey = (type, id) => `whatsapp:session:${sessionId}:key:${type}:${id}`;
  const credsKey = `whatsapp:session:${sessionId}:creds`;

  // Wrap writes in a mutex specifically for this session ID
  const writeData = async (data, key) => {
    return mutex.runExclusive(sessionId, async () => {
      await redis.set(key, JSON.stringify(data, BufferJSON.replacer));
    });
  };

  const readData = async (key) => {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw, BufferJSON.reviver);
  };

  let creds = await readData(credsKey);
  if (!creds) {
    creds = initAuthCreds();
    await writeData(creds, credsKey);
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(getKey(type, id));
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const key = getKey(type, id);
              tasks.push(value ? writeData(value, key) : redis.del(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, credsKey),
  };
};