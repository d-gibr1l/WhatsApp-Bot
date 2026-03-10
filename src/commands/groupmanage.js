import { replyMsg, alertOwner, getTargetNumber, normalizeNumber } from "./helpers.js";

export const groupManageCommands = {

  add: {
    adminOnly: true,
    requiresArgs: true,
    description: "Add a number to the current group",
    usage: "!add <number>",
    examples: ["!add 0244648365", "!add 233244648365"],
    notes: "Bot must be a group admin. Must be used inside a group.",
    handler: async (sock, msg, args, from, prefix) => {
      if (!from.endsWith("@g.us")) {
        return replyMsg(sock, from, msg, "❌ This command can only be used inside a group.");
      }

      const number = normalizeNumber(args[0] ?? "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}add*\n\n🔧 *Syntax:*\n${prefix}add <number>\n\n💡 *Example:*\n• ${prefix}add 0244648365`
      );

      const jid = `${number}@s.whatsapp.net`;

      try {
        const result = await sock.groupParticipantsUpdate(from, [jid], "add");
        const status = result?.[0]?.status;

        if (status === "200") {
          await replyMsg(sock, from, msg, `✅ +${number} has been added to the group.`);
        } else if (status === "403") {
          await replyMsg(sock, from, msg, `❌ +${number} has their privacy settings set to prevent being added to groups.`);
        } else if (status === "408") {
          await replyMsg(sock, from, msg, `❌ +${number} needs to be invited — they can't be added directly.`);
        } else if (status === "409") {
          await replyMsg(sock, from, msg, `ℹ️ +${number} is already in the group.`);
        } else {
          await replyMsg(sock, from, msg, `⚠️ Could not add +${number}. Status: ${status}`);
        }
      } catch (err) {
        console.error("❌ Add member error:", err.message);
        if (err.message?.includes("not-authorized")) {
          await replyMsg(sock, from, msg, "❌ Bot is not a group admin. Make the bot an admin first.");
        } else {
          await replyMsg(sock, from, msg, `❌ Failed to add member: ${err.message}`);
          await alertOwner(sock, `${prefix}add`, err);
        }
      }
    },
  },

  remove: {
    adminOnly: true,
    requiresArgs: false,
    description: "Remove a member from the current group",
    usage: "!remove <number>",
    examples: ["!remove 0244648365", "!remove 233244648365"],
    notes: "Bot must be a group admin. You can also reply to someone's message with !remove.",
    handler: async (sock, msg, args, from, prefix) => {
      if (!from.endsWith("@g.us")) {
        return replyMsg(sock, from, msg, "❌ This command can only be used inside a group.");
      }

      const number = getTargetNumber(msg, args);
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}remove*\n\n🔧 *Syntax:*\n${prefix}remove <number>\n\n📌 Or reply to someone's message with ${prefix}remove`
      );

      const jid = `${number}@s.whatsapp.net`;

      try {
        const result = await sock.groupParticipantsUpdate(from, [jid], "remove");
        const status = result?.[0]?.status;

        if (status === "200") {
          await replyMsg(sock, from, msg, `✅ +${number} has been removed from the group.`);
        } else if (status === "403") {
          await replyMsg(sock, from, msg, `❌ Cannot remove +${number} — they may be an admin.`);
        } else {
          await replyMsg(sock, from, msg, `⚠️ Could not remove +${number}. Status: ${status}`);
        }
      } catch (err) {
        console.error("❌ Remove member error:", err.message);
        if (err.message?.includes("not-authorized")) {
          await replyMsg(sock, from, msg, "❌ Bot is not a group admin. Make the bot an admin first.");
        } else {
          await replyMsg(sock, from, msg, `❌ Failed to remove member: ${err.message}`);
          await alertOwner(sock, `${prefix}remove`, err);
        }
      }
    },
  },

};
