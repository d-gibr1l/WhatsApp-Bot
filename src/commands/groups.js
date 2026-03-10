import { allowGroup, removeGroup, getAllowedGroups } from "../db.js";
import { refreshGroups } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const groupCommands = {

  allowgroup: {
    adminOnly: true,
    requiresArgs: false,
    description: "Allow the bot to respond in the current group",
    usage: "!allowgroup [name]",
    examples: ["!allowgroup", "!allowgroup My Business Group"],
    notes: "Run inside the group you want to allow.",
    handler: async (sock, msg, args, from, prefix) => {
      if (!from.endsWith("@g.us")) return replyMsg(sock, from, msg,
        "❌ This command must be used inside a group chat."
      );
      const name = args.join(" ") || from;
      try {
        await allowGroup(from, name);
        await refreshGroups();
        await replyMsg(sock, from, msg, `✅ Group allowed: ${name}`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}allowgroup`, err);
      }
    },
  },

  removegroup: {
    adminOnly: true,
    requiresArgs: false,
    description: "Stop the bot from responding in the current group",
    handler: async (sock, msg, _args, from, prefix) => {
      if (!from.endsWith("@g.us")) return replyMsg(sock, from, msg,
        "❌ This command must be used inside a group chat."
      );
      try {
        await removeGroup(from);
        await refreshGroups();
        await replyMsg(sock, from, msg, "✅ Group removed from the allowed list.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}removegroup`, err);
      }
    },
  },

  listgroups: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all allowed groups",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const groups = await getAllowedGroups();
        if (!groups.length) return replyMsg(sock, from, msg,
          `No allowed groups set.\n\n📌 The bot is responding in *all* groups.\nUse *${prefix}allowgroup* inside a group to restrict it.`
        );
        const lines = groups.map((g) => `• ${g.name || g.group_id}`).join("\n");
        await replyMsg(sock, from, msg, `*👥 Allowed Groups (${groups.length})*\n\n${lines}`);
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch groups.");
        await alertOwner(sock, `${prefix}listgroups`, err);
      }
    },
  },

};
