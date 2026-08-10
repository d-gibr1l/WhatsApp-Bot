import { banNumber, unbanNumber, getBannedList } from "../db.js";
import { refreshBanned } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const bannedCommands = {

  ban: {
    adminOnly: true,
    requiresArgs: true,
    description: "Ban a number from using the bot",
    usage: "!ban <number> [reason]",
    examples: ["!ban 2348012345678 Spamming", "!ban 2348012345678"],
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}ban*\n\n🔧 *Syntax:*\n${prefix}ban <number> [reason]`
      );
      const reason = args.slice(1).join(" ") || "No reason given";
      try {
        await banNumber(number, reason);
        await refreshBanned();
        await replyMsg(sock, from, msg, `🚫 ${number} has been banned.\nReason: ${reason}`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}ban — ${number}`, err);
      }
    },
  },

  unban: {
    adminOnly: true,
    requiresArgs: true,
    description: "Remove a ban from a number",
    usage: "!unban <number>",
    examples: ["!unban 2348012345678"],
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}unban*\n\n🔧 *Syntax:*\n${prefix}unban <number>`
      );
      try {
        await unbanNumber(number);
        await refreshBanned();
        await replyMsg(sock, from, msg, `✅ ${number} has been unbanned.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}unban — ${number}`, err);
      }
    },
  },

  banlist: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all banned numbers",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const banned = await getBannedList();
        if (!banned.length) return replyMsg(sock, from, msg, "No banned numbers.");
        const lines = banned.map((b) => `• ${b.number} — ${b.reason}`).join("\n");
        await replyMsg(sock, from, msg, `*🚫 Banned (${banned.length})*\n\n${lines}`);
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch ban list.");
        await alertOwner(sock, `${prefix}banlist`, err);
      }
    },
  },

};
