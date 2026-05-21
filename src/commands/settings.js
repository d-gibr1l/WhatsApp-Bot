import { setSetting, getAllSettings } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const settingsCommands = {

  boton: {
    adminOnly: true,
    requiresArgs: false,
    description: "Activate the bot for this chat (or use 'boton all' for global)",
    handler: async (sock, msg, args, from) => {
      if (args[0] && args[0].toLowerCase() === "all") {
        await setSetting("bot_active", "true");
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Bot is now globally active.");
      } else {
        await setSetting(`bot_active_${from}`, "true");
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Bot is now active in this chat.");
      }
    },
  },

  botoff: {
    adminOnly: true,
    requiresArgs: false,
    description: "Deactivate the bot for this chat (or use 'botoff all' for global) — only admins can still use commands",
    handler: async (sock, msg, args, from) => {
      if (args[0] && args[0].toLowerCase() === "all") {
        await setSetting("bot_active", "false");
        await refreshSettings();
        await replyMsg(sock, from, msg, "🔴 Bot deactivated globally. Only admins can use commands.");
      } else {
        await setSetting(`bot_active_${from}`, "false");
        await refreshSettings();
        await replyMsg(sock, from, msg, "🔴 Bot deactivated in this chat. Only admins can use commands.");
      }
    },
  },

  setprefix: {
    adminOnly: true,
    requiresArgs: true,
    description: "Change the command prefix",
    usage: "!setprefix <symbol>",
    examples: ["!setprefix /", "!setprefix .", "!setprefix #"],
    notes: "Takes effect immediately — no restart needed.",
    handler: async (sock, msg, args, from, prefix) => {
      const newPrefix = args[0];
      if (!newPrefix) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setprefix*\n\n🔧 *Syntax:*\n${prefix}setprefix <symbol>`
      );
      try {
        await setSetting("bot_prefix", newPrefix);
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Prefix changed to: *${newPrefix}*`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setprefix`, err);
      }
    },
  },

  setwelcome: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set a custom welcome message for new members",
    usage: "!setwelcome <message>",
    examples: ["!setwelcome Welcome to the group! 🎉 Please read the rules."],
    notes: "You can use WhatsApp formatting: *bold*, _italic_",
    handler: async (sock, msg, args, from, prefix) => {
      try {
        await setSetting("welcome_message", args.join(" "));
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Welcome message updated.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setwelcome`, err);
      }
    },
  },

  settings: {
    adminOnly: true,
    requiresArgs: false,
    description: "Show all current bot settings",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const all = await getAllSettings();
        if (!all.length) return replyMsg(sock, from, msg, "No settings found.");
        const lines = all.map((s) => `• ${s.key}: ${s.value}`).join("\n");
        await replyMsg(sock, from, msg, `*⚙️ Settings*\n\n${lines}`);
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch settings.");
        await alertOwner(sock, `${prefix}settings`, err);
      }
    },
  },

};
