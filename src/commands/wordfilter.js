import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { setSetting, warnUser, banNumber } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Word Filter DB Helpers ───────────────────────────────────────────────────

let wordFilterCache = new Set();

export async function loadWordFilter() {
  try {
    const { data, error } = await supabase.from("word_filter").select("word");
    if (error) throw error;
    wordFilterCache = new Set(data.map((r) => r.word.toLowerCase()));
    console.log(`✅ Word filter loaded — ${wordFilterCache.size} words`);
  } catch (err) {
    console.error("❌ loadWordFilter:", err.message);
  }
}

export function checkWordFilter(text) {
  const lower = text.toLowerCase();
  for (const word of wordFilterCache) {
    if (lower.includes(word)) return word;
  }
  return null;
}

async function addWord(word) {
  const { error } = await supabase
    .from("word_filter")
    .upsert({ word: word.toLowerCase() }, { onConflict: "word" });
  if (error) throw error;
  wordFilterCache.add(word.toLowerCase());
}

async function removeWord(word) {
  const { error } = await supabase
    .from("word_filter")
    .delete()
    .eq("word", word.toLowerCase());
  if (error) throw error;
  wordFilterCache.delete(word.toLowerCase());
}

async function getWordList() {
  const { data, error } = await supabase
    .from("word_filter")
    .select("word")
    .order("word", { ascending: true });
  if (error) throw error;
  return data.map((r) => r.word);
}

// ─── Filter Action (called from handler.js) ───────────────────────────────────

export async function handleWordFilter(sock, msg, text, sender, from) {
  const filterActive = cachedGetSetting("word_filter_active", "true");
  if (filterActive !== "true") return false;

  const matched = checkWordFilter(text);
  if (!matched) return false;

  // Try to delete the message
  try {
    await sock.sendMessage(from, { delete: msg.key });
  } catch {
    // Can't delete — bot may not be group admin, ignore silently
  }

  // Warn the user
  const maxWarns = parseInt(cachedGetSetting("max_warnings", "3"));
  try {
    const count = await warnUser(sender, `Used filtered word: "${matched}"`);
    if (count >= maxWarns) {
      await banNumber(sender, `Auto-banned after ${count} warnings (word filter)`);
      await sock.sendMessage(from, {
        text: `🚫 *${sender}* has been auto-banned after ${count} warnings for using filtered words.`,
      });
    } else {
      await replyMsg(sock, from, msg,
        `⚠️ Your message was removed.\n\n` +
        `🚫 Reason: Filtered word detected\n` +
        `⚠️ Warnings: ${count}/${maxWarns}`
      );
    }
  } catch (err) {
    console.error("❌ Word filter warn error:", err.message);
  }

  return true;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const wordFilterCommands = {

  addword: {
    adminOnly: true,
    requiresArgs: true,
    description: "Add a word to the filter list",
    usage: "!addword <word>",
    examples: ["!addword badword", "!addword spam"],
    notes: "Not case-sensitive. Matches partial words too.",
    handler: async (sock, msg, args, from, prefix) => {
      const word = args[0]?.toLowerCase().trim();
      if (!word) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}addword*\n\n🔧 *Syntax:*\n${prefix}addword <word>`
      );
      try {
        await addWord(word);
        await replyMsg(sock, from, msg, `✅ "*${word}*" added to word filter.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}addword`, err);
      }
    },
  },

  removeword: {
    adminOnly: true,
    requiresArgs: true,
    description: "Remove a word from the filter list",
    usage: "!removeword <word>",
    examples: ["!removeword badword"],
    handler: async (sock, msg, args, from, prefix) => {
      const word = args[0]?.toLowerCase().trim();
      if (!word) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}removeword*\n\n🔧 *Syntax:*\n${prefix}removeword <word>`
      );
      try {
        await removeWord(word);
        await replyMsg(sock, from, msg, `✅ "*${word}*" removed from word filter.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}removeword`, err);
      }
    },
  },

  wordlist: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all filtered words",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const words = await getWordList();
        if (!words.length) return replyMsg(sock, from, msg,
          `No filtered words yet.\n\n📌 Add one with: *${prefix}addword <word>*`
        );
        await replyMsg(sock, from, msg,
          `*🚫 Filtered Words (${words.length})*\n\n${words.map((w) => `• ${w}`).join("\n")}`
        );
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch word list.");
        await alertOwner(sock, `${prefix}wordlist`, err);
      }
    },
  },

  wfilteron: {
    adminOnly: true,
    requiresArgs: false,
    description: "Enable the word filter",
    handler: async (sock, msg, _args, from) => {
      await setSetting("word_filter_active", "true");
      await refreshSettings();
      await replyMsg(sock, from, msg, "✅ Word filter enabled.");
    },
  },

  wfilteroff: {
    adminOnly: true,
    requiresArgs: false,
    description: "Disable the word filter",
    handler: async (sock, msg, _args, from) => {
      await setSetting("word_filter_active", "false");
      await refreshSettings();
      await replyMsg(sock, from, msg, "🔴 Word filter disabled.");
    },
  },

};
