import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { setSetting, getSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";

// ─── Poll ─────────────────────────────────────────────────────────────────────

export const pollCommands = {

  poll: {
    adminOnly: false,
    requiresArgs: true,
    description: "Create a poll in a group",
    usage: "!poll <question> | <option1> | <option2> | ...",
    examples: [
      "!poll Favourite color? | Red | Blue | Green",
      "!poll Best food? | Pizza | Burger | Rice | Pasta",
    ],
    notes: "Separate question and options with |. Min 2, max 12 options.",
    handler: async (sock, msg, args, from, prefix) => {
      const input = args.join(" ").trim();
      const parts = input.split("|").map(s => s.trim()).filter(Boolean);

      if (parts.length < 3) {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}poll <question> | <option1> | <option2>*\n\n` +
          `💡 Example:\n${prefix}poll Favourite color? | Red | Blue | Green`
        );
      }

      if (parts.length > 13) {
        return replyMsg(sock, from, msg, "❌ Maximum 12 options allowed.");
      }

      const question = parts[0];
      const options  = parts.slice(1);

      try {
        await sock.sendMessage(from, {
          poll: {
            name: question,
            values: options,
            selectableCount: 1,
          },
        }, { quoted: msg });
        await reactMsg(sock, from, msg, "✅");
      } catch (err) {
        await failMsg(sock, from, msg, err, "poll");
      }
    },
  },

};

// ─── Welcome / Goodbye ────────────────────────────────────────────────────────

export const welcomeCommands = {

  welcome: {
    adminOnly: true,
    requiresArgs: false,
    description: "Configure welcome messages for new group members",
    usage: "!welcome [on|off|set <message>|show]",
    examples: [
      "!welcome on",
      "!welcome off",
      "!welcome set Welcome {name} to {group}! 🎉",
      "!welcome show",
    ],
    notes: "Variables: {name} = member name, {group} = group name, {number} = their number.",
    handler: async (sock, msg, args, from, prefix) => {
      const sub = args[0]?.toLowerCase();

      if (!sub) return replyMsg(sock, from, msg,
        `📖 *${prefix}welcome*\n\n` +
        `• *${prefix}welcome on* — Enable welcome messages\n` +
        `• *${prefix}welcome off* — Disable welcome messages\n` +
        `• *${prefix}welcome set <message>* — Set custom message\n` +
        `• *${prefix}welcome show* — View current message\n\n` +
        `📌 Variables: {name}, {group}, {number}`
      );

      const key = `welcome_${from}`;
      const enabledKey = `welcome_enabled_${from}`;

      try {
        if (sub === "on") {
          await setSetting(enabledKey, "true");
          await refreshSettings();
          return replyMsg(sock, from, msg, "✅ Welcome messages enabled.");
        }

        if (sub === "off") {
          await setSetting(enabledKey, "false");
          await refreshSettings();
          return replyMsg(sock, from, msg, "🔴 Welcome messages disabled.");
        }

        if (sub === "set") {
          const message = args.slice(1).join(" ").trim();
          if (!message) return replyMsg(sock, from, msg, `❌ Provide a message.\n\nExample: ${prefix}welcome set Welcome {name}! 🎉`);
          await setSetting(key, message);
          await refreshSettings();
          return replyMsg(sock, from, msg, `✅ Welcome message set:\n\n_${message}_`);
        }

        if (sub === "show") {
          const msg_ = await getSetting(key, null);
          const enabled = await getSetting(enabledKey, "false");
          if (!msg_) return replyMsg(sock, from, msg, "No custom welcome message set. Using default.");
          return replyMsg(sock, from, msg,
            `📋 *Welcome Message*\nStatus: ${enabled === "true" ? "✅ Enabled" : "🔴 Disabled"}\n\n_${msg_}_`
          );
        }

        return replyMsg(sock, from, msg, `❌ Unknown option. Use: on, off, set, show`);
      } catch (err) {
        await failMsg(sock, from, msg, err, "welcome");
      }
    },
  },

  goodbye: {
    adminOnly: true,
    requiresArgs: false,
    description: "Configure goodbye messages when members leave a group",
    usage: "!goodbye [on|off|set <message>|show]",
    examples: [
      "!goodbye on",
      "!goodbye off",
      "!goodbye set Goodbye {name}, we'll miss you! 👋",
      "!goodbye show",
    ],
    notes: "Variables: {name} = member name, {group} = group name, {number} = their number.",
    handler: async (sock, msg, args, from, prefix) => {
      const sub = args[0]?.toLowerCase();

      if (!sub) return replyMsg(sock, from, msg,
        `📖 *${prefix}goodbye*\n\n` +
        `• *${prefix}goodbye on* — Enable goodbye messages\n` +
        `• *${prefix}goodbye off* — Disable goodbye messages\n` +
        `• *${prefix}goodbye set <message>* — Set custom message\n` +
        `• *${prefix}goodbye show* — View current message\n\n` +
        `📌 Variables: {name}, {group}, {number}`
      );

      const key = `goodbye_${from}`;
      const enabledKey = `goodbye_enabled_${from}`;

      try {
        if (sub === "on") {
          await setSetting(enabledKey, "true");
          await refreshSettings();
          return replyMsg(sock, from, msg, "✅ Goodbye messages enabled.");
        }

        if (sub === "off") {
          await setSetting(enabledKey, "false");
          await refreshSettings();
          return replyMsg(sock, from, msg, "🔴 Goodbye messages disabled.");
        }

        if (sub === "set") {
          const message = args.slice(1).join(" ").trim();
          if (!message) return replyMsg(sock, from, msg, `❌ Provide a message.\n\nExample: ${prefix}goodbye set Goodbye {name}! 👋`);
          await setSetting(key, message);
          await refreshSettings();
          return replyMsg(sock, from, msg, `✅ Goodbye message set:\n\n_${message}_`);
        }

        if (sub === "show") {
          const msg_ = await getSetting(key, null);
          const enabled = await getSetting(enabledKey, "false");
          if (!msg_) return replyMsg(sock, from, msg, "No custom goodbye message set. Using default.");
          return replyMsg(sock, from, msg,
            `📋 *Goodbye Message*\nStatus: ${enabled === "true" ? "✅ Enabled" : "🔴 Disabled"}\n\n_${msg_}_`
          );
        }

        return replyMsg(sock, from, msg, `❌ Unknown option. Use: on, off, set, show`);
      } catch (err) {
        await failMsg(sock, from, msg, err, "goodbye");
      }
    },
  },

};
