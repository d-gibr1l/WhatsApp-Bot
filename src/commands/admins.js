import { addAdmin, removeAdmin, getAdmins } from "../db.js";
import { refreshAdmins } from "../cache.js";
import { replyMsg, alertOwner, normalizeNumber } from "./helpers.js";

function getSenderFromReply(msg) {
  const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (!participant) return null;
  return participant.split("@")[0];
}

export const adminCommands = {

  addadmin: {
    adminOnly: true,
    requiresArgs: false,
    description: "Add a new admin — by number or reply to their message",
    usage: "!addadmin <number>  OR  reply to someone with !addadmin",
    examples: ["!addadmin 2348012345678", "Reply to a message → !addadmin"],
    notes: "Include country code, no + or spaces.",
    handler: async (sock, msg, args, from, prefix) => {
      // Try reply first, then fall back to typed number
      let number = args[0] ? normalizeNumber(args[0]) : getSenderFromReply(msg);

      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}addadmin*\n\n🔧 *Method 1 — Number:*\n${prefix}addadmin <number>\n\n🔧 *Method 2 — Reply:*\nReply to someone's message with ${prefix}addadmin\n\n💡 *Example:*\n• ${prefix}addadmin 2348012345678`
      );

      try {
        await addAdmin(number);
        await refreshAdmins();
        await replyMsg(sock, from, msg, `✅ ${number} is now an admin.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}addadmin`, err);
      }
    },
  },

  removeadmin: {
    adminOnly: true,
    requiresArgs: false,
    description: "Remove an admin — by number or reply to their message",
    usage: "!removeadmin <number>  OR  reply to someone with !removeadmin",
    examples: ["!removeadmin 2348012345678", "Reply to a message → !removeadmin"],
    handler: async (sock, msg, args, from, prefix) => {
      let number = args[0] ? normalizeNumber(args[0]) : getSenderFromReply(msg);

      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}removeadmin*\n\n🔧 *Method 1 — Number:*\n${prefix}removeadmin <number>\n\n🔧 *Method 2 — Reply:*\nReply to someone's message with ${prefix}removeadmin`
      );

      try {
        await removeAdmin(number);
        await refreshAdmins();
        await replyMsg(sock, from, msg, `✅ ${number} removed from admins.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}removeadmin`, err);
      }
    },
  },

  listadmins: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all current admins",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const admins = await getAdmins();
        if (!admins.length) return replyMsg(sock, from, msg, "No admins found.");
        await replyMsg(sock, from, msg,
          `*👑 Admins (${admins.length})*\n\n${admins.map((a) => `• ${a}`).join("\n")}`
        );
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch admins.");
        await alertOwner(sock, `${prefix}listadmins`, err);
      }
    },
  },

};
