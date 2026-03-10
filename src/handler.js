import { BOT_NUMBER } from "./config.js";
import { commands, replyMsg, isAdmin } from "./commands/index.js";
import { logMessage, getPendingReminders, markReminderDone } from "./db.js";
import {
  cachedIsBanned, cachedIsGroupAllowed, cachedHasAllowedGroups,
  cachedGetSetting, cachedGetAutoReply, cachedIsAdmin,
} from "./cache.js";

export function extractText(msg) {
  const m = msg.message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.buttonsResponseMessage?.selectedButtonId ||
    m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m?.pollCreationMessage?.name ||
    m?.templateButtonReplyMessage?.selectedId ||
    ""
  );
}

export function getSenderNumber(msg) {
  if (msg.key.fromMe) return BOT_NUMBER;
  // In groups, participant is the sender JID e.g. 233XXXXXX@s.whatsapp.net
  // In DMs, remoteJid is the sender JID
  // We only want @s.whatsapp.net JIDs (not @g.us group JIDs)
  const participant = msg.key.participant;
  const remoteJid = msg.key.remoteJid ?? "";
  if (participant && participant.endsWith("@s.whatsapp.net")) {
    return participant.split("@")[0];
  }
  if (remoteJid.endsWith("@s.whatsapp.net")) {
    return remoteJid.split("@")[0];
  }
  // Fallback: strip @s.whatsapp.net or @g.us
  return (participant ?? remoteJid).split("@")[0];
}

// ─── Error Alert ──────────────────────────────────────────────────────────────

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
  if (command.usage) lines.push(`🔧 *Syntax:* ${swap(command.usage)}`);
  if (command.examples?.length) {
    lines.push(`💡 *Examples:*\n${command.examples.map((e) => `• ${swap(e)}`).join("\n")}`);
  }
  if (command.notes) lines.push(`\n📌 *Notes:* ${swap(command.notes)}`);
  return lines.join("\n");
}

// ─── Reminder Poller ─────────────────────────────────────────────────────────

export function startReminderPoller(sock) {
  setInterval(async () => {
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
    }
  }, 30_000);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

const BOT_START_TIME = Date.now();

export async function handleMessage(sock, msg) {
  const text = extractText(msg).trim();
  const sender = getSenderNumber(msg);
  const from = msg.key.remoteJid;
  const isGrp = from.endsWith("@g.us");

  // Debug log
  if (text) {
    console.log(`📩 [${new Date().toLocaleTimeString()}] ${sender}${isGrp ? " @ Group" : ""}: "${text.slice(0, 30)}${text.length > 30 ? "..." : ""}"`);
  }

  // Fundamental filters
  if (!msg.message) return;
  if (from === "status@broadcast") return;
  const msgTs = typeof msg.messageTimestamp === "object" ? msg.messageTimestamp.low * 1000 : msg.messageTimestamp * 1000;
  if (msgTs < BOT_START_TIME) return;
  if (msg.key.fromMe && !text) return;

  // ── All checks below use cache (no DB calls) ──────────────────────────────

  if (cachedIsBanned(sender)) return;

  if (isGrp && cachedHasAllowedGroups() && !cachedIsGroupAllowed(from)) return;

  const botActive = cachedGetSetting("bot_active", "true");
  const userIsAdmin = msg.key.fromMe ? true : cachedIsAdmin(sender);
  if (isGrp && text.startsWith(cachedGetSetting("bot_prefix", "!"))) {
    console.log(`🔑 Admin check — sender: ${sender}, fromMe: ${msg.key.fromMe}, participant: ${msg.key.participant}, isAdmin: ${userIsAdmin}`);
  }
  if (botActive !== "true" && !userIsAdmin) return;

  // Word filter check (skip for admins)
  if (!userIsAdmin && text) {
    const filtered = await handleWordFilter(sock, msg, text, sender, from);
    if (filtered) return;
  }

  // Anti-link check (skip for admins)
  if (!userIsAdmin && text) {
    const blocked = await handleAntiLink(sock, msg, text, sender, from);
    if (blocked) return;
  }

  // Activity logging (non-blocking, fire and forget)
  logMessage(sender, from, isGrp).catch(() => {});

  const prefix = cachedGetSetting("bot_prefix", "!");

  // Auto-replies and AI reply-to-bot trigger
  if (!text.startsWith(prefix)) {
    // Check if replying to bot message — trigger AI
    if (msg.message?.extendedTextMessage?.contextInfo) {
      const handled = await handleAiReply(sock, msg, from);
      if (handled) return;
    }
    if (text) {
      const autoResponse = cachedGetAutoReply(text);
      if (autoResponse) await replyMsg(sock, from, msg, autoResponse);
    }
    return;
  }

  // Command routing
  const args = text.slice(prefix.length).trim().split(/\s+/);
  const cmdName = args.shift().toLowerCase();
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
    await alertOwner(sock, `Command: ${prefix}${cmdName}`, err);
  }
}
