import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { botConfig } from "../config.js";
import { replyMsg } from "./helpers.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── In-memory message store (last 200 messages per chat) ────────────────────
// Structure: Map<chatId, Map<messageId, {text, sender, timestamp, media}>>

const messageStore = new Map();
const MAX_PER_CHAT = 200;

export function storeMessage(msg, text) {
  const from = msg.key.remoteJid;
  const id   = msg.key.id;
  if (!from || !id) return;

  if (!messageStore.has(from)) messageStore.set(from, new Map());
  const chatMap = messageStore.get(from);

  chatMap.set(id, {
    text,
    sender: msg.key.participant ?? msg.key.remoteJid,
    timestamp: Date.now(),
    msg, // keep original msg for media re-download
  });

  // Keep only last MAX_PER_CHAT messages
  if (chatMap.size > MAX_PER_CHAT) {
    const oldest = chatMap.keys().next().value;
    chatMap.delete(oldest);
  }
}

// ─── Handle delete event (called from index.js) ───────────────────────────────

export async function handleAntiDelete(sock, deletedKey) {
  const active = cachedGetSetting("antidelete_active", "false");
  if (active !== "true") return;

  const chatId    = deletedKey.remoteJid;
  const messageId = deletedKey.id;
  if (!chatId || !messageId) return;

  const chatMap = messageStore.get(chatId);
  if (!chatMap) return;

  const stored = chatMap.get(messageId);
  if (!stored) return;

  const senderNumber = (stored.sender ?? "").split("@")[0];
  const timeStr = new Date(stored.timestamp).toLocaleTimeString();

  try {
    const antideleteDest = cachedGetSetting("antidelete_dest", "chat");
    const dest = antideleteDest === "dm"
      ? `${botConfig.BOT_NUMBER}@s.whatsapp.net`
      : chatId;

    if (stored.text) {
      await sock.sendMessage(dest, {
        text:
          `🗑️ *Deleted Message Detected*\n\n` +
          `👤 *From:* +${senderNumber}\n` +
          `🕐 *Time:* ${timeStr}\n` +
          `💬 *Message:* ${stored.text}`,
      });
    } else {
      // Media message — try to re-send
      try {
        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
        const buffer = await downloadMediaMessage(stored.msg, "buffer", {});
        const mediaMsg = stored.msg.message;
        const isImage = !!mediaMsg?.imageMessage;
        const isVideo = !!mediaMsg?.videoMessage;
        const isAudio = !!mediaMsg?.audioMessage;
        const isDoc   = !!mediaMsg?.documentMessage;

        const caption = `🗑️ *Deleted media from +${senderNumber} at ${timeStr}*`;

        if (isImage) {
          await sock.sendMessage(dest, { image: buffer, caption });
        } else if (isVideo) {
          await sock.sendMessage(dest, { video: buffer, caption });
        } else if (isAudio) {
          await sock.sendMessage(dest, { audio: buffer, mimetype: "audio/mpeg" });
        } else if (isDoc) {
          await sock.sendMessage(dest, {
            document: buffer,
            mimetype: mediaMsg.documentMessage.mimetype,
            fileName: mediaMsg.documentMessage.fileName ?? "file",
            caption,
          });
        } else {
          await sock.sendMessage(dest, { text: `🗑️ *Deleted media from +${senderNumber} at ${timeStr}* (unsupported type)` });
        }
      } catch {
        await sock.sendMessage(dest, {
          text: `🗑️ *Deleted media from +${senderNumber} at ${timeStr}* (could not retrieve)`,
        });
      }
    }

    // Remove from store after revealing
    chatMap.delete(messageId);

  } catch (err) {
    console.error("❌ Anti-delete error:", err.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const antideleteCommands = {

  antideleteon: {
    adminOnly: true,
    requiresArgs: false,
    description: "Enable anti-delete — reveals deleted messages",
    handler: async (sock, msg, _args, from) => {
      await setSetting("antidelete_active", "true");
      await refreshSettings();
      await replyMsg(sock, from, msg,
        `✅ Anti-delete enabled.\n\n` +
        `Deleted messages will be revealed in the chat.\n` +
        `To send reveals to your DM instead: *!antideletedm*`
      );
    },
  },

  antideleteoff: {
    adminOnly: true,
    requiresArgs: false,
    description: "Disable anti-delete",
    handler: async (sock, msg, _args, from) => {
      await setSetting("antidelete_active", "false");
      await refreshSettings();
      await replyMsg(sock, from, msg, "🔴 Anti-delete disabled.");
    },
  },

  antideletechat: {
    adminOnly: true,
    requiresArgs: false,
    description: "Send revealed messages back to the chat",
    handler: async (sock, msg, _args, from) => {
      await setSetting("antidelete_dest", "chat");
      await refreshSettings();
      await replyMsg(sock, from, msg, "✅ Deleted messages will be revealed in the *chat*.");
    },
  },

  antideletedm: {
    adminOnly: true,
    requiresArgs: false,
    description: "Send revealed messages to your private DM",
    handler: async (sock, msg, _args, from) => {
      await setSetting("antidelete_dest", "dm");
      await refreshSettings();
      await replyMsg(sock, from, msg, "✅ Deleted messages will be sent to your *private DM*.");
    },
  },

};
