import { addAutoReply, removeAutoReply, getAllAutoReplies } from "../db.js";
import { refreshAutoReplies } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const autoreplyCommands = {

  autoreply: {
    adminOnly: true,
    requiresArgs: true,
    description: "Add an automatic reply when someone sends a specific keyword",
    usage: "!autoreply <keyword> | <response>",
    examples: [
      "!autoreply hello | Hey there! 👋 How can I help?",
      "!autoreply price | Our prices start from $10.",
    ],
    notes: "Separate keyword and response with a | symbol. Not case-sensitive.",
    handler: async (sock, msg, args, from, prefix) => {
      const full = args.join(" ");
      const [keyword, ...rest] = full.split("|");
      if (!keyword || !rest.length) {
        return replyMsg(sock, from, msg,
          `📖 *How to use ${prefix}autoreply*\n\n` +
          `🔧 *Syntax:*\n${prefix}autoreply <keyword> | <response>\n\n` +
          `💡 *Example:*\n• ${prefix}autoreply hello | Hey there! 👋\n\n` +
          `📌 Separate keyword and response with a *|* symbol.`
        );
      }
      try {
        await addAutoReply(keyword.trim(), rest.join("|").trim());
        await refreshAutoReplies();
        await replyMsg(sock, from, msg, `✅ Auto reply added.\n\nKeyword: "${keyword.trim()}"\nResponse: "${rest.join("|").trim()}"`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}autoreply`, err);
      }
    },
  },

  removeautoreply: {
    adminOnly: true,
    requiresArgs: true,
    description: "Remove an auto reply by its keyword",
    usage: "!removeautoreply <keyword>",
    examples: ["!removeautoreply hello"],
    handler: async (sock, msg, args, from, prefix) => {
      const keyword = args.join(" ").trim();
      if (!keyword) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}removeautoreply*\n\n🔧 *Syntax:*\n${prefix}removeautoreply <keyword>`
      );
      try {
        await removeAutoReply(keyword);
        await refreshAutoReplies();
        await replyMsg(sock, from, msg, `✅ Auto reply removed for: "${keyword}"`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}removeautoreply`, err);
      }
    },
  },

  listautorepies: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all auto replies",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const list = await getAllAutoReplies();
        if (!list.length) return replyMsg(sock, from, msg,
          `No auto replies set.\n\n📌 Add one with: *${prefix}autoreply <keyword> | <response>*`
        );
        const lines = list.map((r) => `• "${r.keyword}" → ${r.response}`).join("\n");
        await replyMsg(sock, from, msg, `*💬 Auto Replies (${list.length})*\n\n${lines}`);
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch auto replies.");
        await alertOwner(sock, `${prefix}listautorepies`, err);
      }
    },
  },

};
