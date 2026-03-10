import { BOT_NUMBER } from "../config.js";
import { isAdminNumber } from "../db.js";
import { cachedIsAdmin } from "../cache.js";

export function replyMsg(sock, from, msg, text) {
  return sock.sendMessage(from, { text }, { quoted: msg });
}

export function reactMsg(sock, from, msg, emoji) {
  return sock.sendMessage(from, {
    react: { text: emoji, key: msg.key },
  });
}

export function isAdmin(msg) {
  if (msg.key.fromMe) return true;
  // In groups, participant holds the sender JID
  // In DMs, remoteJid holds the sender JID (but only if it ends with @s.whatsapp.net)
  const jid = msg.key.participant
    ?? (msg.key.remoteJid?.endsWith("@s.whatsapp.net") ? msg.key.remoteJid : null)
    ?? "";
  const number = jid.split("@")[0];
  return cachedIsAdmin(number);
}

export async function alertOwner(sock, context, err) {
  try {
    const ownerJid = `${BOT_NUMBER}@s.whatsapp.net`;
    await sock.sendMessage(ownerJid, {
      text:
        `⚠️ *Bot Error Alert*\n\n` +
        `📍 *Where:* ${context}\n` +
        `❌ *Error:* ${err.message}\n` +
        `🕐 *Time:* ${new Date().toLocaleString()}\n` +
        `🔢 *Stack:* ${err.stack?.split("\n")[1]?.trim() ?? "N/A"}`,
    });
  } catch {
    // silently fail
  }
}

export function normalizeNumber(raw) {
  // Remove all non-digits
  let number = raw.replace(/\D/g, "");
  // Convert local format (leading 0) to international using BOT_NUMBER country code
  if (number.startsWith("0")) {
    const countryCode = BOT_NUMBER.slice(0, BOT_NUMBER.length - 9); // extract country code
    number = countryCode + number.slice(1);
  }
  return number;
}

export function getTargetNumber(msg, args) {
  // If a number is provided as first arg, normalize and use it
  if (args[0] && /^\d/.test(args[0])) {
    return normalizeNumber(args[0]);
  }
  // Otherwise try to get number from quoted/replied message
  const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  const remoteJid   = msg.message?.extendedTextMessage?.contextInfo?.remoteJid;
  const jid = participant ?? (remoteJid?.endsWith("@s.whatsapp.net") ? remoteJid : null);
  if (jid) return jid.split("@")[0];
  return null;
}

export function parseTime(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * multipliers[unit];
}

export function formatDuration(ms) {
  if (ms < 60000)    return `${ms / 1000}s`;
  if (ms < 3600000)  return `${ms / 60000}m`;
  if (ms < 86400000) return `${ms / 3600000}h`;
  return `${ms / 86400000}d`;
}
