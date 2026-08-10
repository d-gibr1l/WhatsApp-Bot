import { botConfig } from "./config.js";
import { commands, replyMsg, isAdmin } from "./commands/registry.js";
import { reactMsg } from "./commands/helpers.js";
import { logMessage, getPendingReminders, markReminderDone } from "./db.js";
import {
  cachedIsBanned, cachedIsGroupAllowed, cachedHasAllowedGroups,
  cachedGetSetting, cachedGetAutoReply, cachedIsAdmin,
  seenMessage, rememberMessage,
} from "./cache.js";
import { handleAiReply } from "./commands/ai.js";
import { handleWordFilter } from "./commands/wordfilter.js";
import { handleAntiLink } from "./commands/antilink.js";
import { resolveAlias } from "./commands/aliases.js";
import { hasStickerSession, handleStickerSessionImage } from "./commands/sticker.js";
import { LRUCache } from "lru-cache";

// ─── extractText ─────────────────────────────────────────────────────────────

export function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedId ||
    ""
  );
}

// ─── getMessageType helper ───────────────────────────────────────────────────

export function getMessageType(msg) {
  return Object.keys(msg.message || {})[0] ?? "unknown";
}

// ─── getSenderNumber ──────────────────────────────────────────────────────────

export function getSenderNumber(msg) {
  if (msg.key.fromMe) return botConfig.BOT_NUMBER;
  const participant = msg.key.participant;
  const remoteJid   = msg.key.remoteJid ?? "";
  if (participant && participant.endsWith("@s.whatsapp.net")) {
    return participant.split("@")[0];
  }
  if (remoteJid.endsWith("@s.whatsapp.net")) {
    return remoteJid.split("@")[0];
  }
  return (participant ?? remoteJid).split("@")[0];
}

// ─── Error Alert ─────────────────────────────────────────────────────────────

const alertRateLimit = new LRUCache({ max: 50, ttl: 60000 }); 

export async function alertOwner(sock, context, err, extra = {}) {
  try {
    const errorKey = `${context}:${err.message}`;
    if (alertRateLimit.has(errorKey)) return;
    alertRateLimit.set(errorKey, true);

    const ownerJid = `${botConfig.BOT_NUMBER}@s.whatsapp.net`;
    await sock.sendMessage(ownerJid, {
      text:
        `⚠️ *Bot Error Alert*\n\n` +
        `📍 *Where:* ${context}\n` +
        `❌ *Error:* ${err.message}\n` +
        (extra.sender ? `👤 *Sender:* ${extra.sender}\n` : "") +
        (extra.from    ? `💬 *Chat:* ${extra.from}\n`   : "") +
        (extra.text    ? `📝 *Message:* ${String(extra.text).slice(0, 50)}\n` : "") +
        `🕐 *Time:* ${new Date().toLocaleString()}\n` +
        `🔢 *Stack:* ${err.stack?.split("\n")[1]?.trim() ?? "N/A"}`,
    });
  } catch (e) {
    console.error("Critical: Could not alert owner.", e.message);
  }
}

// ─── Usage Builder ────────────────────────────────────────────────────────────

function buildUsageMessage(cmdName, command, prefix) {
  const swap = (str) => str.replaceAll("!", prefix);
  const lines = [
    `📖 *How to use ${prefix}${cmdName}*`,
    `📝 *Description:* ${command.description}\n`,
  ];
  if (command.usage)          lines.push(`🔧 *Syntax:* ${swap(command.usage)}`);
  if (command.examples?.length) {
    lines.push(`💡 *Examples:*\n${command.examples.map((e) => `• ${swap(e)}`).join("\n")}`);
  }
  if (command.notes)          lines.push(`\n📌 *Notes:* ${swap(command.notes)}`);
  return lines.join("\n");
}

// ─── Reminder Poller ─────────────────────────────────────────────────────────

export function startReminderPoller(sock) {
  let running = false;

  const intervalId = setInterval(async () => {
    if (running) return; 
    running = true;
    try {
      const due = await getPendingReminders();
      if (!due || due.length === 0) return;
      for (const reminder of due) {
        try {
          await sock.sendMessage(reminder.chat_id, {
            text: `⏰ *Reminder*\n\n${reminder.message}`,
          });
          await markReminderDone(reminder.id);
        } catch (err) {
          console.error(`❌ Reminder ID ${reminder.id} failed:`, err.message);
          await alertOwner(sock, `Reminder Poller (ID: ${reminder.id})`, err);
        }
      }
    } catch (err) {
      console.error("❌ Poller Database Error:", err.message);
    } finally {
      running = false;
    }
  }, 30_000);

  return () => clearInterval(intervalId);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

let connectedAt = Infinity; 
const messageSignatures = new Map();

export function markBotReady() {
  connectedAt = Date.now();
  console.log(`[Handler] Bot marked ready at ${connectedAt} — now accepting messages.`);
}

export function isBotReady() {
  return connectedAt !== Infinity;
}

export async function handleMessage(sock, msg) {
  try {
    await processMessage(sock, msg);
  } catch (err) {
    console.error("Critical unhandled error in handleMessage:", err.message);
    await alertOwner(sock, "Global handleMessage Exception", err);
  }
}

async function processMessage(sock, msg) {
  if (!msg.message) return;
  const from = msg.key.remoteJid;
  if (!from)                          return;
  if (from === "status@broadcast")    return;

  if (hasStickerSession(from)) {
    const msgContent = msg.message?.ephemeralMessage?.message ||
                       msg.message?.viewOnceMessageV2?.message ||
                       msg.message?.viewOnceMessage?.message ||
                       msg.message;
    if (msgContent?.imageMessage || msgContent?.videoMessage) {
      const handled = await handleStickerSessionImage(sock, msg, from);
      if (handled) return;
    }
  }

  const msgId = msg.key.id;
  if (msgId && seenMessage(msgId)) return;
  if (msgId) rememberMessage(msgId);

  let tsRaw = msg.messageTimestamp;
  if (typeof tsRaw === "object" && tsRaw !== null && "low" in tsRaw) tsRaw = tsRaw.low;
  let msgTs = (Number(tsRaw) || 0) * 1000;
  if (msgTs > 100000000000000) msgTs = Math.floor(msgTs / 1000);
  
  // FIXED: Explicitly drop messages older than the connection time to prevent race conditions during DB loading
  if (msgTs < connectedAt) return;
  
  if (!msgTs || isNaN(msgTs) || Date.now() - msgTs > 120_000) {
    return;
  }

  const text     = extractText(msg).trim();
  const sender   = getSenderNumber(msg);
  const isGrp    = from.endsWith("@g.us");
  const prefix   = cachedGetSetting("bot_prefix", "!");
  const userIsAdmin = msg.key.fromMe ? true : cachedIsAdmin(sender);

  if (msg.key.fromMe && !text) return;

  if (cachedIsBanned(sender)) return;
  if (isGrp && cachedHasAllowedGroups() && !cachedIsGroupAllowed(from)) return;

  const botActiveGlobal = cachedGetSetting("bot_active", "true");
  const botActiveLocal = cachedGetSetting(`bot_active_${from}`, "true");

  if (!userIsAdmin) {
    if (botActiveGlobal !== "true") return; 
    if (botActiveLocal === "false") return; 
  }

  if (!text.startsWith(prefix)) {
    if (!userIsAdmin && text) {
      const filtered = await handleWordFilter(sock, msg, text, sender, from);
      if (filtered) return;
      const blocked = await handleAntiLink(sock, msg, text, sender, from);
      if (blocked) return;
    }
  }

  logMessage(sender, from, isGrp);

  if (!text.startsWith(prefix)) {
    if (msg.message?.extendedTextMessage?.contextInfo) {
      const handled = await handleAiReply(sock, msg, from);
      if (handled) return;
    }
    if (text) {
      const autoResponse = cachedGetAutoReply(text) ?? cachedGetAutoReply("*");
      if (autoResponse) await replyMsg(sock, from, msg, autoResponse);
    }
    return;
  }

  const args = [];
  const strippedText = text.slice(prefix.length).trim();
  let currentArg = '';
  let inQuotes = false;
  
  for (let i = 0; i < strippedText.length; i++) {
    const char = strippedText[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (currentArg) {
        args.push(currentArg);
        currentArg = '';
      }
    } else {
      currentArg += char;
    }
  }
  if (currentArg) args.push(currentArg);

  const rawCmd = args.shift()?.toLowerCase();
  if (!rawCmd) return;

  const resolved = resolveAlias(rawCmd);
  const resolvedParts = (resolved || rawCmd).split(" ");
  const cmdName = resolvedParts[0];
  const command = commands[cmdName];
  
  if (resolvedParts.length > 1) {
    args.unshift(...resolvedParts.slice(1));
  }

  if (!command) return;

  await reactMsg(sock, from, msg, "⏳").catch(() => {});

  const argsLog = args.length > 0 ? ` ${args.join(" ")}` : "";
  console.log(`⚡ [CMD] ${prefix}${cmdName}${argsLog}`);

  if (command.adminOnly && !userIsAdmin) {
    return await replyMsg(sock, from, msg, "🚫 This command is reserved for Admins.");
  }

  if (command.requiresArgs && args.length === 0) {
    return await replyMsg(sock, from, msg, buildUsageMessage(cmdName, command, prefix));
  }

  try {
    await command.handler(sock, msg, args, from, prefix);
  } catch (err) {
    console.error(`💥 Error in ${prefix}${cmdName}:`, err);
    await replyMsg(sock, from, msg, "⚠️ An internal error occurred while processing that command.");
    await alertOwner(sock, `Command: ${prefix}${cmdName}`, err, { sender, from, text });
  }
}