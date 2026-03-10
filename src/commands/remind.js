import { addReminder } from "../db.js";
import { replyMsg, alertOwner, parseTime, formatDuration } from "./helpers.js";

export const remindCommands = {

  remind: {
    adminOnly: false,
    requiresArgs: true,
    description: "Set a reminder that the bot will send you after a set time",
    usage: "!remind <time> <message>",
    examples: [
      "!remind 10m Call John",
      "!remind 2h Team meeting starts",
      "!remind 1d Pay electricity bill",
    ],
    notes: "Time format: s = seconds, m = minutes, h = hours, d = days",
    handler: async (sock, msg, args, from, prefix) => {
      if (args.length < 2) {
        return replyMsg(sock, from, msg,
          `📖 *How to use ${prefix}remind*\n\n` +
          `🔧 *Syntax:*\n${prefix}remind <time> <message>\n\n` +
          `💡 *Examples:*\n• ${prefix}remind 10m Call John\n• ${prefix}remind 2h Meeting\n• ${prefix}remind 1d Pay rent\n\n` +
          `📌 *Time formats:* s = seconds, m = minutes, h = hours, d = days`
        );
      }
      const ms = parseTime(args[0]);
      if (!ms) return replyMsg(sock, from, msg, `❌ Invalid time format.\n\n📌 Valid: 30s, 10m, 2h, 1d`);
      const message = args.slice(1).join(" ");
      const sender  = msg.key.participant ?? msg.key.remoteJid ?? "";
      const number  = sender.split("@")[0];
      const fireAt  = new Date(Date.now() + ms).toISOString();
      try {
        await addReminder(number, from, message, fireAt);
        await replyMsg(sock, from, msg, `⏰ Reminder set for *${formatDuration(ms)}* from now.\n\n📝 "${message}"`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ Failed to set reminder: ${err.message}`);
        await alertOwner(sock, `${prefix}remind`, err);
      }
    },
  },

};
