import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { botConfig } from "../config.js";
import { setSetting, storeAntiDeletePayload, getAntiDeletePayload } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg } from "./helpers.js";
import { LRUCache } from "lru-cache";

// ─── In-memory message store (Global LRU Cache) ────────────────────────────────
// Holds 50,000 messages globally. Ensures busy chats don't drop history quickly.
const messageStore = new LRUCache({ max: 50000 });

export function storeMessage(msg, text) {
  const from = msg.key.remoteJid;
  const id   = msg.key.id;
  if (!from || !id) return;

  const m = msg.message || {};
  
  // Only ignore pure Baileys protocol/encryption updates. 
  // DO NOT ignore messageContextInfo, as it drops WhatsApp Web messages!
  if (m.protocolMessage || m.senderKeyDistributionMessage) return;

  const sender = msg.key.participant ?? msg.key.remoteJid;
  const pushName = msg.pushName || null;
  
  const payload = {
    text,
    sender,
    pushName,
    timestamp: Date.now(),
    msg,
    chatId: from
  };

  // Instant in-memory cache
  messageStore.set(id, payload);
  
  // Persistent database cold storage (fire and forget)
  storeAntiDeletePayload(id, from, sender, pushName, payload).catch(() => {});
}

// ─── Group metadata cache ─────────────────────────────────────────────────────
// groupMetadata() makes a live network request to WhatsApp — doing this on
// every delete event adds 500–3000ms of latency per alert. Cache it for 5 min.

const groupMetaCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });

async function getCachedGroupMeta(sock, chatId) {
  const cached = groupMetaCache.get(chatId);
  if (cached) return cached;
  const meta = await sock.groupMetadata(chatId).catch(() => null);
  if (meta) groupMetaCache.set(chatId, meta);
  return meta;
}

// ─── Handle delete event ──────────────────────────────────────────────────────

const getDisplayName = async (sock, chatId, jid, pushName = null) => {
  const number = jid.split("@")[0];
  let name = pushName;
  if (!name && chatId.endsWith("@g.us")) {
    const meta = await getCachedGroupMeta(sock, chatId);
    const participant = meta?.participants?.find(p => p.id === jid);
    name = participant?.notify || participant?.name || null;
  }
  return name ? `${name} (+${number})` : `+${number}`;
};

const getMentions = (m) => {
  const content = m?.ephemeralMessage?.message || m?.viewOnceMessage?.message || m?.viewOnceMessageV2?.message || m;
  const msgData = content?.extendedTextMessage || content?.imageMessage || content?.videoMessage || content?.audioMessage || content?.documentMessage;
  return msgData?.contextInfo?.mentionedJid || [];
};

export async function handleAntiDelete(sock, deletedKey, deleterJid = null) {
  const active = cachedGetSetting("antidelete_active", "false");
  if (active !== "true") return;

  const chatId    = deletedKey.remoteJid;
  const messageId = deletedKey.id;
  if (!chatId || !messageId) return;

  let stored = messageStore.get(messageId);
  
  if (!stored) {
    // Fallback to Supabase cold storage (survives restarts)
    const dbRecord = await getAntiDeletePayload(messageId);
    if (!dbRecord) return;
    stored = dbRecord.payload;
  } else {
    // Remove from RAM immediately — prevents duplicate reveals
    messageStore.delete(messageId);
  }

  const timeStr = new Date(stored.timestamp).toLocaleTimeString();

  // ── Display name & Admin deleter resolution ────────────────────────────────
  const originalSenderDisplayName = await getDisplayName(sock, chatId, stored.sender, stored.pushName);
  
  let deleterDisplayName = null;
  const isSender = !deleterJid || deleterJid === stored.sender;
  if (!isSender) {
    deleterDisplayName = await getDisplayName(sock, chatId, deleterJid);
  }

  let headerText = `👤 *From:* ${originalSenderDisplayName}`;
  if (deleterDisplayName) {
    headerText += `\n🗑️ *Deleted by:* ${deleterDisplayName}`;
  }

  const antideleteDest = cachedGetSetting("antidelete_dest", "chat");
  const dest = antideleteDest === "dm"
    ? `${botConfig.BOT_NUMBER}@s.whatsapp.net`
    : chatId;

  const mentions = getMentions(stored.msg.message);

  try {
    if (stored.text) {
      // Text message — send immediately, no download needed
      await sock.sendMessage(dest, {
        text:
          `🗑️ *Deleted Message Detected*\n\n` +
          `${headerText}\n` +
          `🕐 *Time:* ${timeStr}\n` +
          `💬 *Message:* ${stored.text}`,
        mentions,
      });
      return;
    }

    // ── Media message ─────────────────────────────────────────────────────
    // Send a "message deleted" placeholder immediately so the user sees
    // something right away, then download and re-send the media in the background.
    const caption = `🗑️ *Deleted media from ${originalSenderDisplayName} at ${timeStr}*` + (deleterDisplayName ? ` (deleted by ${deleterDisplayName})` : "");
    const mediaMsg = stored.msg.message;
    const isImage    = !!mediaMsg?.imageMessage;
    const isVideo    = !!mediaMsg?.videoMessage;
    const isAudio    = !!mediaMsg?.audioMessage;
    const isDoc      = !!mediaMsg?.documentMessage;
    const isSticker  = !!mediaMsg?.stickerMessage;
    const isViewOnce = !!(mediaMsg?.viewOnceMessage || mediaMsg?.viewOnceMessageV2);

    // Placeholder lands in chat immediately (<100ms)
    await sock.sendMessage(dest, {
      text: `${caption}\n_Downloading media..._`,
      mentions,
    });

    // Download and re-send asynchronously — does not block the event loop
    (async () => {
      try {
        const buffer = await downloadMediaMessage(stored.msg, "buffer", {});

        if (isSticker) {
          await sock.sendMessage(dest, { sticker: buffer });
        } else if (isViewOnce) {
          const voMsg = mediaMsg?.viewOnceMessage?.message ?? mediaMsg?.viewOnceMessageV2?.message;
          if (voMsg?.imageMessage) {
            await sock.sendMessage(dest, { image: buffer, caption: caption + " *(view-once)*", mentions });
          } else if (voMsg?.videoMessage) {
            await sock.sendMessage(dest, { video: buffer, caption: caption + " *(view-once)*", mentions });
          } else if (voMsg?.audioMessage) {
            await sock.sendMessage(dest, { audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true });
          }
        } else if (isImage) {
          await sock.sendMessage(dest, { image: buffer, caption, mentions });
        } else if (isVideo) {
          await sock.sendMessage(dest, { video: buffer, caption, mentions });
        } else if (isAudio) {
          await sock.sendMessage(dest, { audio: buffer, mimetype: "audio/mpeg" });
        } else if (isDoc) {
          await sock.sendMessage(dest, {
            document: buffer,
            mimetype: mediaMsg.documentMessage.mimetype,
            fileName: mediaMsg.documentMessage.fileName ?? "file",
            caption,
            mentions,
          });
        }
      } catch (err) {
        console.error("❌ Failed to download and send media for anti-delete:", err.message);
        await sock.sendMessage(dest, {
          text: `${caption} *(media could not be retrieved)*`,
          mentions,
        }).catch(() => {});
      }
    })();

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
