import { botConfig } from "./config.js";
import { commands, replyMsg, isAdmin } from "./commands/index.js";
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

// ─── extractText (fix #5 — simplified, removed poll noise) ───────────────────

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

// ─── getMessageType helper (fix #10) ─────────────────────────────────────────

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

// ─── Error Alert (fix #9 — more context) ─────────────────────────────────────

export async function alertOwner(sock, context, err, extra = {}) {
  try {
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

// ─── Reminder Poller (fix #8 — overlap protection) ───────────────────────────

export function startReminderPoller(sock) {
  let running = false;

  const intervalId = setInterval(async () => {
    if (running) return; // prevent overlap if DB is slow
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

  // Return cleanup function so caller can stop this poller before starting a new one
  return () => clearInterval(intervalId);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

const BOT_START_TIME = Date.now();

export async function handleMessage(sock, msg) {

  // ── Fix #1: Fast early exits — skip invalid/system messages ─────────────
  if (!msg.message) return;
  const from = msg.key.remoteJid;
  if (!from)                          return;
  if (from === "status@broadcast")    return;

  // Fix #7: Deduplication — skip if already processed
  const msgId = msg.key.id;
  if (msgId && seenMessage(msgId)) return;
  if (msgId) rememberMessage(msgId);

  // Fix #2: Safe timestamp handling across all Baileys versions
  const msgTs = (Number(msg.messageTimestamp) || 0) * 1000;
  if (msgTs && msgTs < BOT_START_TIME) return;

  const text     = extractText(msg).trim();
  const sender   = getSenderNumber(msg);
  const isGrp    = from.endsWith("@g.us");
  const prefix   = cachedGetSetting("bot_prefix", "!");
  const userIsAdmin = msg.key.fromMe ? true : cachedIsAdmin(sender);

  if (msg.key.fromMe && !text) return;

  // Debug log
  if (text) {
    console.log(`📩 [${new Date().toLocaleTimeString()}] ${sender}${isGrp ? " @ Group" : ""}: "${text.slice(0, 30)}${text.length > 30 ? "..." : ""}"`);
  }

  // ── Cache-only checks (no DB) ────────────────────────────────────────────
  if (cachedIsBanned(sender)) return;
  if (isGrp && cachedHasAllowedGroups() && !cachedIsGroupAllowed(from)) return;

  const botActive = cachedGetSetting("bot_active", "true");
  if (botActive !== "true" && !userIsAdmin) return;

  // Fix #3: Only run word filter + anti-link on non-command messages
  if (!text.startsWith(prefix)) {
    if (!userIsAdmin && text) {
      const filtered = await handleWordFilter(sock, msg, text, sender, from);
      if (filtered) return;
      const blocked = await handleAntiLink(sock, msg, text, sender, from);
      if (blocked) return;
    }
  }

  // Activity logging (non-blocking)
  logMessage(sender, from, isGrp).catch(() => {});

  // ── Auto-replies and AI ──────────────────────────────────────────────────
  if (!text.startsWith(prefix)) {
    if (msg.message?.extendedTextMessage?.contextInfo) {
      const handled = await handleAiReply(sock, msg, from);
      if (handled) return;
    }
    if (text) {
      // Check specific keyword match first, then wildcard fallback
      const autoResponse = cachedGetAutoReply(text) ?? cachedGetAutoReply("*");
      if (autoResponse) await replyMsg(sock, from, msg, autoResponse);
    }
    return;
  }

  // ── Command routing ──────────────────────────────────────────────────────

  // Fix #6: Support quoted arguments e.g. !remind "buy milk tomorrow"
  const args = text
    .slice(prefix.length)
    .trim()
    .match(/"[^"]+"|\S+/g)
    ?.map((a) => a.replace(/"/g, "")) || [];

  const rawCmd = args.shift()?.toLowerCase();
  if (!rawCmd) return;

  const cmdName = resolveAlias(rawCmd);
  const command = commands[cmdName];
  if (!command) return;

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
