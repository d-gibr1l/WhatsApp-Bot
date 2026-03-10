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

function resolveJid(target) {
  // If it looks like a group JID already
  if (target.endsWith("@g.us")) return target;
  if (target.endsWith("@s.whatsapp.net")) return target;
  // Normalize number and make user JID
  const number = normalizeNumber(target);
  return `${number}@s.whatsapp.net`;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const schedulerCommands = {

  send: {
    adminOnly: true,
    requiresArgs: true,
    description: "Send a message to a number or group repeatedly at an interval",
    usage: "!send <number> <message> <interval> <Xt>",
    examples: [
      "!send 0244648365 Good morning! 1h 5t",
      "!send 0244648365 Don't forget the meeting 30m 3t",
    ],
    notes: "Interval format: 10s, 5m, 2h — Times format: 3t, 10t etc.",
    handler: async (sock, msg, args, from, prefix) => {
      if (args.length < 4) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}send*\n\n` +
        `🔧 *Syntax:*\n${prefix}send <number> <message> <interval> <times>\n\n` +
        `💡 *Examples:*\n` +
        `• ${prefix}send 0244648365 Good morning! 1h 5t\n` +
        `• ${prefix}send 0244648365 Reminder: meeting now 30m 3t\n\n` +
        `📌 *Interval:* 10s, 5m, 2h\n` +
        `📌 *Times:* 3t, 10t (how many times to send)`
      );

      const target      = args[0];
      const intervalStr = args[args.length - 2];
      const timesStr    = args[args.length - 1];
      const text        = args.slice(1, -2).join(" ");

      const interval = parseInterval(intervalStr);
      const times    = parseInt(timesStr.replace("t", ""));

      if (!interval) return replyMsg(sock, from, msg,
        `❌ Invalid interval format. Use: *10s*, *5m*, *2h*`
      );
      if (isNaN(times) || times <= 0) return replyMsg(sock, from, msg,
        `❌ Invalid times format. Use: *3t*, *10t*`
      );
      if (!text) return replyMsg(sock, from, msg,
        `❌ Message text cannot be empty.`
      );
      if (times > 99999) return replyMsg(sock, from, msg,
        `❌ Maximum 99999 times allowed.`
      );
      if (interval < 0.009) return replyMsg(sock, from, msg,
        `❌ Minimum interval is 0.009 seconds.`
      );

      const jid = resolveJid(target);

      // Stop any existing job for this target
      if (activeJobs.has(target)) {
        clearInterval(activeJobs.get(target).job);
        activeJobs.delete(target);
      }

      let count = 0;

      const job = setInterval(async () => {
        if (count >= times) {
          clearInterval(job);
          activeJobs.delete(target);
          return;
        }
        try {
          await sock.sendMessage(jid, { text });
        } catch (err) {
          console.error(`❌ Scheduled send error:`, err.message);
          clearInterval(job);
          activeJobs.delete(target);
        }
        count++;
      }, interval);

      activeJobs.set(target, { job, text, intervalStr, times, jid });

      await replyMsg(sock, from, msg,
        `✅ *Scheduled!*\n\n` +
        `📤 *To:* ${target}\n` +
        `💬 *Message:* ${text}\n` +
        `⏱️ *Interval:* ${intervalStr}\n` +
        `🔢 *Times:* ${times}\n\n` +
        `📌 Stop anytime with: *${prefix}stopsend ${target}*`
      );
    },
  },

  stopsend: {
    adminOnly: true,
    requiresArgs: true,
    description: "Stop a scheduled message to a number",
    usage: "!stopsend <number>",
    examples: ["!stopsend 0244648365"],
    handler: async (sock, msg, args, from, prefix) => {
      const target = args[0];
      if (!target) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}stopsend*\n\n🔧 *Syntax:*\n${prefix}stopsend <number>`
      );

      if (!activeJobs.has(target)) return replyMsg(sock, from, msg,
        `ℹ️ No active scheduled messages for *${target}*.`
      );

      clearInterval(activeJobs.get(target).job);
      activeJobs.delete(target);
      await replyMsg(sock, from, msg, `✅ Stopped scheduled messages to *${target}*.`);
    },
  },

  activesends: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all active scheduled messages",
    handler: async (sock, msg, _args, from, prefix) => {
      if (activeJobs.size === 0) return replyMsg(sock, from, msg,
        `ℹ️ No active scheduled messages.\n\n📌 Start one with: *${prefix}send*`
      );

      const lines = [...activeJobs.entries()].map(([target, info]) =>
        `• *${target}* — "${info.text.slice(0, 30)}${info.text.length > 30 ? "..." : ""}" every ${info.intervalStr}`
      );

      await replyMsg(sock, from, msg,
        `*📅 Active Scheduled Messages (${activeJobs.size})*\n\n${lines.join("\n")}`
      );
    },
  },

};