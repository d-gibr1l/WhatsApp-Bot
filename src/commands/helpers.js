import { botConfig } from "../config.js";
import { cachedIsAdmin, rememberBotSent } from "../cache.js";

// ─── Messaging Helpers ───────────────────────────────────────────────────────

/**
 * Standardized reply function. Tracks the message ID so the AI 
 * doesn't accidentally reply to the bot's own messages.
 */
export async function replyMsg(sock, from, msg, text) {
  const result = await sock.sendMessage(from, { text }, { quoted: msg });
  if (result?.key?.id) rememberBotSent(result.key.id);
  return result;
}

/**
 * Simple reaction helper
 */
export function reactMsg(sock, from, msg, emoji) {
  return sock.sendMessage(from, {
    react: { text: emoji, key: msg.key },
  });
}

/**
 * Reacts with ❌ and silently DMs the owner the error stack trace.
 * Perfect for keeping group chats clean when a command fails.
 */
export async function failMsg(sock, from, msg, err, context = "") {
  try { await reactMsg(sock, from, msg, "❌"); } catch {}
  try {
    const ownerJid = `${botConfig.BOT_NUMBER}@s.whatsapp.net`;
    if (!botConfig.BOT_NUMBER) return; // Prevent crashes if bot number isn't set
    
    const senderJid = msg.key.participant ?? msg.key.remoteJid ?? "unknown";
    const errMsg = err instanceof Error ? err.message : String(err);
    
    await sock.sendMessage(ownerJid, {
      text:
        `⚠️ *Command Failed*\n\n` +
        `📍 *Command:* ${context}\n` +
        `👤 *From:* ${senderJid.split("@")[0]}\n` +
        `💬 *Chat:* ${from.split("@")[0]}\n` +
        `❌ *Error:* ${errMsg.slice(0, 300)}\n` +
        `🕐 *Time:* ${new Date().toLocaleString()}`,
    });
  } catch {
    // silently fail — never crash on error reporting
  }
}

/**
 * General purpose error alert for system-level failures
 */
export async function alertOwner(sock, context, err, extra = {}) {
  try {
    const ownerJid = `${botConfig.BOT_NUMBER}@s.whatsapp.net`;
    if (!botConfig.BOT_NUMBER) return;

    const errMsg = err instanceof Error ? err.message : String(err);
    await sock.sendMessage(ownerJid, {
      text:
        `⚠️ *Bot Error Alert*\n\n` +
        `📍 *Where:* ${context}\n` +
        `❌ *Error:* ${errMsg.slice(0, 300)}\n` +
        (extra.sender ? `👤 *Sender:* ${extra.sender}\n` : "") +
        (extra.from   ? `💬 *Chat:* ${extra.from}\n`   : "") +
        (extra.text   ? `📝 *Message:* ${String(extra.text).slice(0, 50)}\n` : "") +
        `🕐 *Time:* ${new Date().toLocaleString()}\n` +
        `🔢 *Stack:* ${err.stack?.split("\n")[1]?.trim() ?? "N/A"}`,
    });
  } catch {
    // silently fail
  }
}

// ─── Number & Auth Helpers ───────────────────────────────────────────────────

/**
 * Checks if the sender of the current message is an admin
 */
export function isAdmin(msg) {
  if (msg.key.fromMe) return true;
  const jid = msg.key.participant
    ?? (msg.key.remoteJid?.endsWith("@s.whatsapp.net") ? msg.key.remoteJid : null)
    ?? "";
  const number = jid.split("@")[0];
  return cachedIsAdmin(number);
}

/**
 * Strips formatting and applies the default country code if missing
 */
export function normalizeNumber(raw) {
  let number = String(raw).replace(/\D/g, "");
  
  if (number.startsWith("0")) {
    // Rely on an explicit config variable, fallback to "233" (Ghana) if missing
    const countryCode = botConfig.DEFAULT_COUNTRY_CODE || "233"; 
    number = countryCode + number.slice(1);
  }
  
  return number;
}

/**
 * Extracts a target number from either a command argument (like a mention) 
 * or a quoted message.
 */
export function getTargetNumber(msg, args) {
  // Safely grab mentions (e.g., "@123456") or raw numbers
  if (args[0]) {
    const cleanedArg = String(args[0]).replace(/\D/g, "");
    if (cleanedArg.length >= 7) { 
      return normalizeNumber(cleanedArg);
    }
  }
  
  // Otherwise try to get number from quoted/replied message
  const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  const remoteJid   = msg.message?.extendedTextMessage?.contextInfo?.remoteJid;
  const jid = participant ?? (remoteJid?.endsWith("@s.whatsapp.net") ? remoteJid : null);
  
  // Consistently normalize the extracted JID
  if (jid) return normalizeNumber(jid.split("@")[0]); 
  
  return null;
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

/**
 * Converts strings like "10m" or "2h" into milliseconds
 */
export function parseTime(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * multipliers[unit];
}

/**
 * Converts milliseconds into a readable short string (e.g., "5.0m")
 */
export function formatDuration(ms) {
  if (ms < 60000)    return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000)  return `${(ms / 60000).toFixed(1)}m`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`;
  return `${(ms / 86400000).toFixed(1)}d`;
}