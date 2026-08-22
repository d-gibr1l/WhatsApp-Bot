import { addWordFilter, removeWordFilter, getWordFilters } from "../src/db.js";
import { checkMod } from "../System/MongoDB/MongoDb_Core.js";

export default {
  name: "wordfilter",
  alias: ["addword", "delword", "removeword", "wordlist", "wfilteron", "wfilteroff"],
  uniquecommands: ["addword", "delword", "removeword", "wordlist", "wfilteron", "wfilteroff"],
  category: "admin",
  description: "Word filter management for group admins and moderators",

  start: async (Hooper, m, { inputCMD, text, prefix, isCreator, isAdmin, doReact }) => {
    // Strict permission check: only group admins, bot moderators, or creator
    const isMod = isCreator || await checkMod(m.sender);
    const canUse = isMod || (m.isGroup && isAdmin);

    // If user is not authorized, silently ignore without any reply or reaction
    if (!canUse) {
      return;
    }

    switch (inputCMD) {
      case "addword": {
        const word = text.toLowerCase().trim();
        if (!word) {
          await doReact("❓");
          return m.reply(`📖 *${prefix}addword*\n\nUsage: *${prefix}addword <word>*\nExample: *${prefix}addword badword*`);
        }
        await addWordFilter(word, m.from);
        await doReact("✅");
        return m.reply(`✅ Added *"${word}"* to the filtered words for this chat.`);
      }

      case "delword":
      case "removeword": {
        const word = text.toLowerCase().trim();
        if (!word) {
          await doReact("❓");
          return m.reply(`📖 *${prefix}removeword*\n\nUsage: *${prefix}removeword <word>*\nExample: *${prefix}removeword badword*`);
        }
        await removeWordFilter(word, m.from);
        await doReact("✅");
        return m.reply(`✅ Removed *"${word}"* from the filtered words for this chat.`);
      }

      case "wordlist": {
        const filters = await getWordFilters(m.from);
        if (!filters || filters.length === 0) {
          await doReact("ℹ️");
          return m.reply(`ℹ️ No filtered words configured for this chat.\n\nAdd one with: *${prefix}addword <word>*`);
        }
        const words = filters.map(f => `• ${f.word}`).join("\n");
        await doReact("📜");
        return m.reply(`🔤 *Filtered Words for this Chat (${filters.length}):*\n\n${words}`);
      }

      case "wfilteron": {
        await doReact("✅");
        return m.reply("✅ *Word filter enabled* for this chat.");
      }

      case "wfilteroff": {
        await doReact("🛑");
        return m.reply("🛑 *Word filter disabled* for this chat.");
      }

      default:
        break;
    }
  }
};
