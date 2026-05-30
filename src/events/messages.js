import { LRUCache } from "lru-cache";
import { handleMessage, extractText, isBotReady } from "../handler.js";
import { handleAntiDelete, storeMessage } from "../commands/antidelete.js";
import { chatQueue } from "../queue.js";
import { rememberMessage } from "../cache.js";

const recentlyRevoked = new LRUCache({ max: 500, ttl: 5000 });

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

    // Block ALL command processing until the bot is marked ready.
    // This prevents replying to historical messages that WhatsApp
    // flushes immediately after every reconnect.
    // BUT: still record their IDs in the dedup cache so they're
    // recognized as "already processed" once the bot becomes ready.
    if (!isBotReady()) {
      for (const msg of messages) {
        const id = msg?.key?.id;
        if (id) rememberMessage(id);
      }
      return;
    }

    for (const msg of messages) {
      const jid = msg?.key?.remoteJid;
      if (!msg.message || !jid) continue;
      
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
