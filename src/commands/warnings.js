import { warnUser, getWarnings, clearWarnings, banNumber, getSetting } from "../db.js";
import { cachedGetSetting, refreshBanned } from "../cache.js";
import { replyMsg, alertOwner, getTargetNumber } from "./helpers.js";

export const warningCommands = {

  warn: {
    adminOnly: true,
    requiresArgs: true,
    description: "Issue a warning to a user. Auto-bans after max warnings",
    usage: "!warn <number> [reason]",
    examples: ["!warn 2348012345678 Spamming the group"],
    notes: "Default max warnings is 3. Change it with !setmaxwarns",
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}warn*\n\n🔧 *Syntax:*\n${prefix}warn <number> [reason]\n\n💡 *Example:*\n• ${prefix}warn 2348012345678 Spamming`
      );
      const reason   = args.slice(1).join(" ") || "No reason given";
      const maxWarns = parseInt(cachedGetSetting("max_warnings", "3"));
      try {
        const count = await warnUser(number, reason);
        if (count >= maxWarns) {
          await banNumber(number, `Auto-banned after ${count} warnings`);
          await refreshBanned();
          await replyMsg(sock, from, msg,
            `⚠️ *${number}* warned (${count}/${maxWarns}).\nReason: ${reason}\n\n🚫 Auto-banned after reaching the warning limit.`
          );
        } else {
          await replyMsg(sock, from, msg, `⚠️ *${number}* warned (${count}/${maxWarns}).\nReason: ${reason}`);
        }
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}warn — ${number}`, err);
      }
    },
  },

  warnings: {
    adminOnly: false,
    requiresArgs: true,
    description: "Check how many warnings a number has",
    usage: "!warnings <number>",
    examples: ["!warnings 2348012345678"],
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}warnings*\n\n🔧 *Syntax:*\n${prefix}warnings <number>`
      );
      const { count, reasons } = await getWarnings(number);
      const maxWarns = cachedGetSetting("max_warnings", "3");
      if (count === 0) return replyMsg(sock, from, msg, `✅ ${number} has no warnings.`);
      const reasonList = reasons.map((r, i) => `${i + 1}. ${r}`).join("\n");
      await replyMsg(sock, from, msg, `⚠️ *Warnings for ${number}* (${count}/${maxWarns})\n\n${reasonList}`);
    },
  },

  clearwarn: {
    adminOnly: true,
    requiresArgs: true,
    description: "Clear all warnings for a number",
    usage: "!clearwarn <number>",
    examples: ["!clearwarn 2348012345678"],
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}clearwarn*\n\n🔧 *Syntax:*\n${prefix}clearwarn <number>`
      );
      try {
        await clearWarnings(number);
        await replyMsg(sock, from, msg, `✅ Warnings cleared for ${number}.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}clearwarn — ${number}`, err);
      }
    },
  },

  setmaxwarns: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set how many warnings before a user is auto-banned",
    usage: "!setmaxwarns <number>",
    examples: ["!setmaxwarns 3", "!setmaxwarns 5"],
    notes: "Default is 3.",
    handler: async (sock, msg, args, from, prefix) => {
      const { setSetting } = await import("../db.js");
      const { refreshSettings } = await import("../cache.js");
      const num = parseInt(args[0]);
      if (isNaN(num) || num < 1) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setmaxwarns*\n\n🔧 *Syntax:*\n${prefix}setmaxwarns <number>`
      );
      try {
        await setSetting("max_warnings", String(num));
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Max warnings set to ${num}.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setmaxwarns`, err);
      }
    },
  },

};
