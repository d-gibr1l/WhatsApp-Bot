import { LRUCache } from "lru-cache";
import { handleMessage, extractText } from "../handler.js";
import { handleAntiDelete, storeMessage } from "../commands/antidelete.js";
import { chatQueue } from "../queue.js";

const recentlyRevoked = new LRUCache({ max: 500, ttl: 5000 });
const startTime = Date.now();

async function safeHandleDelete(sock, key, deleterJid = null) {
  const id = key?.id;
  if (!id || recentlyRevoked.has(id)) return;
  recentlyRevoked.set(id, true);
  await handleAntiDelete(sock, key, deleterJid);
}

export function bindMessagesEvents(sock) {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      const jid = msg?.key?.remoteJid;
      if (!jid) continue;

      if (msg.message) {
        storeMessage(msg, extractText(msg) ?? "");
      }

      const protoMsg = msg.message?.protocolMessage;
      if (protoMsg?.type === 0 && protoMsg?.key) {
        try {
          const deleterJid = msg.key.participant || msg.key.remoteJid;
          await safeHandleDelete(sock, protoMsg.key, deleterJid);
        } catch (err) {
          console.error("Anti-delete (revoke) error:", err.message);
        }
      }
    }

    if (type !== "notify") return;

    for (const msg of messages) {
      let tsRaw = msg.messageTimestamp;
      if (typeof tsRaw === "object" && tsRaw !== null && "low" in tsRaw) tsRaw = tsRaw.low;
      let ts = (Number(tsRaw) || 0) * 1000;
      if (ts > 100000000000000) ts = Math.floor(ts / 1000); // In case it was already in ms
      
      const jid = msg?.key?.remoteJid;
      if (ts === 0 || ts < startTime || !msg.message || !jid) continue;
      
      chatQueue.enqueue(jid, async () => {
        try {
          await handleMessage(sock, msg);
        } catch (err) {
          console.error("Error processing message:", err.message);
        }
      });
    }
  });

  sock.ev.on("messages.delete", async (item) => {
    try {
      let keys = [];
      if (item.keys)          keys = item.keys;
      else if (item.key)      keys = [item.key];
      else if (item.messages) keys = item.messages.map(m => m.key).filter(Boolean);
      for (const key of keys) await safeHandleDelete(sock, key);
    } catch (err) {
      console.error("Anti-delete (bulk) error:", err.message);
    }
  });
}
