import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const apikeyCommands = {

  setapikey: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set the RapidAPI key for the media downloader",
    usage: "!setapikey <key>",
    examples: ["!setapikey abc123xyz..."],
    notes: "Get your key from rapidapi.com. Stored securely in the database.",
    handler: async (sock, msg, args, from, prefix) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setapikey*\n\n🔧 *Syntax:*\n${prefix}setapikey <key>\n\n📌 Get your key from rapidapi.com`
      );
      try {
        await setSetting("rapidapi_key", key);
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ RapidAPI key updated successfully.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setapikey`, err);
      }
    },
  },

  checkapikey: {
    adminOnly: true,
    requiresArgs: false,
    description: "Check if the RapidAPI key is set",
    handler: async (sock, msg, _args, from, prefix) => {
      const key = cachedGetSetting("rapidapi_key", null);
      if (!key || key.trim() === "") {
        await replyMsg(sock, from, msg, `❌ No RapidAPI key set.\n\n📌 Use *${prefix}setapikey <key>* to set one.`);
      } else {
        const masked = `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
        await replyMsg(sock, from, msg, `✅ RapidAPI key is set.\n🔑 Key: ${masked}`);
      }
    },
  },

};
