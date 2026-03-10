import { addAdmin, removeAdmin, getAdmins } from "../db.js";
import { refreshAdmins } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const adminCommands = {

  addadmin: {
    adminOnly: true,
    requiresArgs: true,
    description: "Add a new admin who can use admin-only commands",
    usage: "!addadmin <number>",
    examples: ["!addadmin 2348012345678"],
    notes: "Include country code, no + or spaces.",
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}addadmin*\n\n🔧 *Syntax:*\n${prefix}addadmin <number>\n\n💡 *Example:*\n• ${prefix}addadmin 2348012345678\n\n📌 Include country code, no + or spaces.`
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
    requiresArgs: true,
    description: "Remove someone from the admin list",
    usage: "!removeadmin <number>",
    examples: ["!removeadmin 2348012345678"],
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}removeadmin*\n\n🔧 *Syntax:*\n${prefix}removeadmin <number>`
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
