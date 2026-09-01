import { jidNormalizedUser } from "@whiskeysockets/baileys";

// ── Anti-Delete pure helpers ────────────────────────────────────────────────
// Extracted from the `messages.update` revoke handler in index.js so the
// fiddly JID/media logic can be unit-tested without a live socket.

/**
 * Normalize a JID to a real user JID, or "" if it isn't one.
 * - maps `<n>@lid` → phone JID when the map knows it
 * - strips device suffixes via jidNormalizedUser
 * - rejects anything that isn't `@s.whatsapp.net` (groups, broadcast, bare lids)
 *
 * A `@g.us` JID must never survive this: WhatsApp renders a group JID inside
 * a `mentions` array as the whole group, which is what made every recovered
 * message look like it came "from one group".
 *
 * @param {string} jid
 * @param {{ has: (k: string) => boolean, get: (k: string) => string } | Map | undefined} lidMap
 * @returns {string}
 */
export function resolveUser(jid, lidMap) {
  if (!jid) return "";
  if (jid.endsWith("@lid") && lidMap?.has?.(jid)) jid = lidMap.get(jid);
  jid = jidNormalizedUser(jid);
  return jid.endsWith("@s.whatsapp.net") ? jid : "";
}

/**
 * Work out who sent the deleted message and who deleted it.
 *
 * In a group the author is always `key.participant`; `key.remoteJid` is the
 * group itself, so it may only be used as a fallback for 1:1 chats.
 *
 * @param {object}  opts
 * @param {object}  opts.cachedKey          the stored message's `key`
 * @param {string}  opts.chatId             `key.remoteJid` from the update event
 * @param {string} [opts.updateParticipant] `update.participant` (set for admin revoke)
 * @param {string} [opts.botUserId]         `sock.user.id`, used when the message was fromMe
 * @param {*}      [opts.lidMap]            lid → phone map
 * @returns {{ isGroupChat: boolean, rawSender: string, actualSender: string, deleter: string }}
 */
export function resolveParties({
  cachedKey = {},
  chatId = "",
  updateParticipant = "",
  botUserId = "",
  lidMap,
} = {}) {
  const isGroupChat = (chatId || "").endsWith("@g.us");
  const rawSender = cachedKey.fromMe
    ? botUserId || ""
    : cachedKey.participant || (isGroupChat ? "" : cachedKey.remoteJid) || "";
  const actualSender = resolveUser(rawSender, lidMap);
  const deleter = resolveUser(updateParticipant || rawSender || "", lidMap);
  return { isGroupChat, rawSender, actualSender, deleter };
}

const MEDIA_MAP = {
  imageMessage: { mediaLabel: "picture", mediaType: "image" },
  videoMessage: { mediaLabel: "video", mediaType: "video" },
  ptvMessage: { mediaLabel: "video note", mediaType: "ptv" },
  audioMessage: { mediaLabel: "audio", mediaType: "audio" },
  stickerMessage: { mediaLabel: "sticker", mediaType: "sticker" },
  documentMessage: { mediaLabel: "document", mediaType: "document" },
  documentWithCaptionMessage: { mediaLabel: "document", mediaType: "document" },
};

/**
 * Map a Baileys contentType to a human label and the exact `type` string
 * `downloadContentFromMessage` expects. `mediaType` is null for text and for
 * anything that isn't downloadable media (polls, locations, contacts …).
 *
 * @param {string} contentType
 * @returns {{ mediaLabel: string, mediaType: string | null }}
 */
export function pickMedia(contentType) {
  return MEDIA_MAP[contentType] || { mediaLabel: "message", mediaType: null };
}

/**
 * Keep only real user JIDs — never a group / broadcast JID — for `mentions`,
 * deduped (e.g. an admin revoking their own message means deleter ===
 * actualSender, which would otherwise mention the same person twice).
 */
export function sanitizeMentions(list) {
  const seen = new Set();
  for (const j of list || []) {
    if (j && j.endsWith("@s.whatsapp.net")) seen.add(j);
  }
  return [...seen];
}
