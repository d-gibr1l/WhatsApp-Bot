import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY, botConfig } from "../config.js";
import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg } from "./helpers.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── In-memory message store (last 500 messages per chat) ────────────────────

const messageStore = new Map();
const MAX_PER_CHAT = 500;

export function storeMessage(msg, text) {
  const from = msg.key.remoteJid;
  const id   = msg.key.id;
  if (!from || !id) return;

  const m = msg.message || {};
  const isSystem = !!(
    m.protocolMessage ||
    m.senderKeyDistributionMessage ||
    m.messageContextInfo
  );
  if (isSystem && !text && !m.imageMessage && !m.videoMessage &&
      !m.audioMessage && !m.documentMessage && !m.stickerMessage &&
      !m.viewOnceMessage && !m.viewOnceMessageV2) return;

  if (!messageStore.has(from)) messageStore.set(from, new Map());
  const chatMap = messageStore.get(from);

  chatMap.set(id, {
    text,
    sender:    msg.key.participant ?? msg.key.remoteJid,
    pushName:  msg.pushName || null,
    timestamp: Date.now(),
    msg,
  });

  if (chatMap.size > MAX_PER_CHAT) {
    const oldest = chatMap.keys().next().value;
    chatMap.delete(oldest);
  }
}

// ─── Group metadata cache ─────────────────────────────────────────────────────
// groupMetadata() makes a live network request to WhatsApp — doing this on
// every delete event adds 500–3000ms of latency per alert. Cache it for 5 min.

const groupMetaCache = new Map(); // chatId → { meta, fetchedAt }
const GROUP_META_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedGroupMeta(sock, chatId) {
  const cached = groupMetaCache.get(chatId);
  if (cached && Date.now() - cached.fetchedAt < GROUP_META_TTL) {
    return cached.meta;
  }
  const meta = await sock.groupMetadata(chatId).catch(() => null);
  if (meta) groupMetaCache.set(chatId, { meta, fetchedAt: Date.now() });
  return meta;
}

// ─── Handle delete event ──────────────────────────────────────────────────────

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

  // Remove immediately — prevents duplicate reveals if the event fires twice
  chatMap.delete(messageId);

  const senderNumber = (stored.sender ?? "").split("@")[0];
  const timeStr      = new Date(stored.timestamp).toLocaleTimeString();

  // ── Display name resolution ───────────────────────────────────────────────
  // Priority: pushName (stored at message-receive time, free) →
  //           cached group metadata (5-min TTL, one network call) →
  //           phone number fallback
  let senderName = stored.pushName || null;
  if (!senderName && chatId.endsWith("@g.us")) {
    // Uses the 5-min cache — no live network call if metadata was fetched recently
    const meta = await getCachedGroupMeta(sock, chatId);
    const participant = meta?.participants?.find(p => p.id === stored.sender);
    senderName = participant?.notify || participant?.name || null;
  }
  const displayName = senderName ? `${senderName} (+${senderNumber})` : `+${senderNumber}`;

  const antideleteDest = cachedGetSetting("antidelete_dest", "chat");
  const dest = antideleteDest === "dm"
    ? `${botConfig.BOT_NUMBER}@s.whatsapp.net`
    : chatId;

  try {
    if (stored.text) {
      // Text message — send immediately, no download needed
      await sock.sendMessage(dest, {
        text:
          `🗑️ *Deleted Message Detected*\n\n` +
          `👤 *From:* ${displayName}\n` +
          `🕐 *Time:* ${timeStr}\n` +
          `💬 *Message:* ${stored.text}`,
      });
      return;
    }

    // ── Media message ─────────────────────────────────────────────────────
    // Send a "message deleted" placeholder immediately so the user sees
    // something right away, then download and re-send the media in the background.
    // This is what makes reveals feel instant even for large videos.
    const caption = `🗑️ *Deleted media from ${displayName} at ${timeStr}*`;
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
            await sock.sendMessage(dest, { image: buffer, caption: caption + " *(view-once)*" });
          } else {
            await sock.sendMessage(dest, { video: buffer, caption: caption + " *(view-once)*" });
          }
        } else if (isImage) {
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
        }
      } catch {
        await sock.sendMessage(dest, {
          text: `${caption} *(media could not be retrieved)*`,
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
