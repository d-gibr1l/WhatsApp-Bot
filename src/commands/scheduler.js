import { replyMsg, alertOwner, normalizeNumber } from "./helpers.js";

// ─── Active Jobs Store ────────────────────────────────────────────────────────

const activeJobs = new Map();

function parseInterval(time) {
  const num = parseInt(time);
  if (isNaN(num)) return null;
  if (time.endsWith("s")) return num * 1000;
  if (time.endsWith("m")) return num * 60000;
  if (time.endsWith("h")) return num * 3600000;
  return null;
}

function isJidOrNumber(str) {
  // Returns true if the string looks like a number or JID (not a message word)
  return /^\d/.test(str) || str.endsWith("@g.us") || str.endsWith("@s.whatsapp.net");
}

function resolveJid(target) {
  if (target.endsWith("@g.us"))          return target;
  if (target.endsWith("@s.whatsapp.net")) return target;
  const number = normalizeNumber(target);
  return `${number}@s.whatsapp.net`;
}

function friendlyJid(jid) {
  if (jid.endsWith("@g.us"))           return `group:${jid.split("@")[0].slice(-6)}`;
  if (jid.endsWith("@s.whatsapp.net")) return jid.split("@")[0];
  return jid;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const schedulerCommands = {

  send: {
    adminOnly: true,
    requiresArgs: true,
    description: "Schedule a repeated message — auto-uses current chat if no number given",
    usage: "!send <message> <interval> <Xt>  OR  !send <number> <message> <interval> <Xt>",
    examples: [
      "!send Good morning! 1h 5t",
      "!send Reminder: meeting now 30m 3t",
      "!send 0244648365 Good morning! 1h 5t",
      "!send 120363xxxxxx@g.us Daily update 12h 7t",
    ],
    notes: "Interval: 10s, 5m, 2h — Times: 3t, 10t — No number = sends to current chat.",
    handler: async (sock, msg, args, from, prefix) => {
      if (args.length < 3) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}send*\n\n` +
        `*In current chat (no number needed):*\n` +
        `${prefix}send <message> <interval> <times>\n\n` +
        `*To a specific number/group:*\n` +
        `${prefix}send <number> <message> <interval> <times>\n\n` +
        `💡 *Examples:*\n` +
        `• ${prefix}send Good morning! 1h 5t\n` +
        `• ${prefix}send 0244648365 Reminder 30m 3t\n\n` +
        `📌 *Interval:* 10s, 5m, 2h\n` +
        `📌 *Times:* 3t, 10t`
      );

      // Detect if first arg is a number/JID or part of the message
      let target, textArgs;
      if (isJidOrNumber(args[0])) {
        // !send <number> <message> <interval> <times>
        target   = args[0];
        textArgs = args.slice(1);
      } else {
        // !send <message> <interval> <times> — use current chat
        target   = from;
        textArgs = args;
      }

      if (textArgs.length < 3) return replyMsg(sock, from, msg,
        `❌ Not enough arguments.\n\n` +
        `Usage: *${prefix}send <message> <interval> <times>*\n` +
        `Example: *${prefix}send Good morning! 1h 5t*`
      );

      const intervalStr = textArgs[textArgs.length - 2];
      const timesStr    = textArgs[textArgs.length - 1];
      const text        = textArgs.slice(0, -2).join(" ");

      const interval = parseInterval(intervalStr);
      const times    = parseInt(timesStr.replace("t", ""));

      if (!interval)           return replyMsg(sock, from, msg, `❌ Invalid interval. Use: *10s*, *5m*, *2h*`);
      if (isNaN(times) || times <= 0) return replyMsg(sock, from, msg, `❌ Invalid times. Use: *3t*, *10t*`);
      if (!text)               return replyMsg(sock, from, msg, `❌ Message cannot be empty.`);
      if (times > 10000)         return replyMsg(sock, from, msg, `❌ Maximum 10000 times.`);
      if (interval < 200)     return replyMsg(sock, from, msg, `❌ Minimum interval is 1 seconds.`);

      const jid     = resolveJid(target);
      const jobKey  = jid; // use JID as key so stopsend works cleanly

      // Stop any existing job for this target
      if (activeJobs.has(jobKey)) {
        clearInterval(activeJobs.get(jobKey).job);
        activeJobs.delete(jobKey);
      }

      let count = 0;
      const job = setInterval(async () => {
        if (count >= times) {
          clearInterval(job);
          activeJobs.delete(jobKey);
          return;
        }
        try {
          await sock.sendMessage(jid, { text });
        } catch (err) {
          console.error(`❌ Scheduled send error:`, err.message);
          clearInterval(job);
          activeJobs.delete(jobKey);
        }
        count++;
      }, interval);

      activeJobs.set(jobKey, { job, text, intervalStr, times, jid });

      const displayTarget = target === from ? "this chat" : friendlyJid(jid);

      await replyMsg(sock, from, msg,
        `✅ *Scheduled!*\n\n` +
        `📤 *To:* ${displayTarget}\n` +
        `💬 *Message:* ${text}\n` +
        `⏱️ *Interval:* ${intervalStr}\n` +
        `🔢 *Times:* ${times}\n\n` +
        `📌 Stop with: *${prefix}stopsend*`
      );
    },
  },

  stopsend: {
    adminOnly: true,
    requiresArgs: false,
    description: "Stop a scheduled message — stops current chat's schedule if no number given",
    usage: "!stopsend [number]",
    examples: [
      "!stopsend",
      "!stopsend 0244648365",
    ],
    handler: async (sock, msg, args, from, prefix) => {
      // No arg = stop current chat's schedule
      const target = args[0] ? resolveJid(args[0]) : from;

      if (!activeJobs.has(target)) return replyMsg(sock, from, msg,
        activeJobs.size === 0
          ? `ℹ️ No active scheduled messages.`
          : `ℹ️ No active schedule for this chat.\n\n📌 Use *${prefix}activesends* to see all active schedules.`
      );

      clearInterval(activeJobs.get(target).job);
      activeJobs.delete(target);
      await replyMsg(sock, from, msg, `✅ Stopped scheduled messages for *${friendlyJid(target)}*.`);
    },
  },

  activesends: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all active scheduled messages",
    handler: async (sock, msg, _args, from, prefix) => {
      if (activeJobs.size === 0) return replyMsg(sock, from, msg,
        `ℹ️ No active scheduled messages.\n\n📌 Start one with: *${prefix}send Good morning! 1h 5t*`
      );

      const lines = [...activeJobs.entries()].map(([jid, info]) =>
        `• *${friendlyJid(jid)}* — "${info.text.slice(0, 30)}${info.text.length > 30 ? "..." : ""}" every ${info.intervalStr}`
      );

      await replyMsg(sock, from, msg,
        `*📅 Active Schedules (${activeJobs.size})*\n\n${lines.join("\n")}`
      );
    },
  },

};
