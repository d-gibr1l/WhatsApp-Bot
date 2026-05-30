import { setSetting, warnUser, banNumber, supabase } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// ─── Cache: per-chat words only ───────────────────────────────────────────────
// chatWords: Map of chat_id -> Set of words

let chatWords = new Map();

export async function loadWordFilter() {
  try {
    const { data, error } = await supabase.from("word_filter").select("word, chat_id");
    if (error) throw error;
    chatWords = new Map();
    for (const r of data) {
      const word   = r.word.toLowerCase();
      const chatId = r.chat_id;
      if (!chatId || chatId === "global") continue; // ignore old global entries
      if (!chatWords.has(chatId)) chatWords.set(chatId, new Set());
      chatWords.get(chatId).add(word);
    }
    console.log(`✅ Word filter loaded — ${chatWords.size} chats with filters`);
  } catch (err) {
    console.error("❌ loadWordFilter:", err.message);
  }
}

export function checkWordFilter(text, chatId) {
  const lower = text.toLowerCase();
  const words = chatWords.get(chatId);
  if (!words) return null;
  for (const word of words) {
    if (lower.includes(word)) return word;
  }
  return null;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function addWord(word, chatId) {
  const { error } = await supabase
    .from("word_filter")
    .upsert({ word: word.toLowerCase(), chat_id: chatId }, { onConflict: "word,chat_id" });
  if (error) throw error;
  if (!chatWords.has(chatId)) chatWords.set(chatId, new Set());
  chatWords.get(chatId).add(word.toLowerCase());
}

async function removeWord(word, chatId) {
  const { error } = await supabase
    .from("word_filter")
    .delete()
    .eq("word", word.toLowerCase())
    .eq("chat_id", chatId);
  if (error) throw error;
  chatWords.get(chatId)?.delete(word.toLowerCase());
}

async function getWordList(chatId) {
  const { data, error } = await supabase
    .from("word_filter")
    .select("word")
    .eq("chat_id", chatId)
    .order("word", { ascending: true });
  if (error) throw error;
  return data.map((r) => r.word);
}

// ─── Filter Action ────────────────────────────────────────────────────────────

export async function handleWordFilter(sock, msg, text, sender, from) {
  const filterActive = cachedGetSetting("word_filter_active", "true");
  if (filterActive !== "true") return false;

  const matched = checkWordFilter(text, from);
  if (!matched) return false;

  try { await sock.sendMessage(from, { delete: msg.key }); } catch {}

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
    description: "Add a word to the filter for this chat/group",
    usage: "!addword <word>",
    examples: ["!addword badword"],
    handler: async (sock, msg, args, from, prefix) => {
      const word = args[0]?.toLowerCase().trim();
      if (!word) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}addword*\n\n🔧 *Syntax:*\n${prefix}addword <word>`
      );
      try {
        await addWord(word, from);
        await replyMsg(sock, from, msg, `✅ "*${word}*" added to the filter for this chat.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}addword`, err);
      }
    },
  },

  removeword: {
    adminOnly: true,
    requiresArgs: true,
    description: "Remove a word from this chat/group's filter",
    usage: "!removeword <word>",
    examples: ["!removeword badword"],
    handler: async (sock, msg, args, from, prefix) => {
      const word = args[0]?.toLowerCase().trim();
      if (!word) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}removeword*\n\n🔧 *Syntax:*\n${prefix}removeword <word>`
      );
      try {
        await removeWord(word, from);
        await replyMsg(sock, from, msg, `✅ "*${word}*" removed from this chat's filter.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}removeword`, err);
      }
    },
  },

  wordlist: {
    adminOnly: true,
    requiresArgs: false,
    description: "List filtered words for this chat/group",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const words = await getWordList(from);
        if (!words.length) return replyMsg(sock, from, msg,
          `No filtered words for this chat.\n\n📌 Add one with: *${prefix}addword <word>*`
        );
        await replyMsg(sock, from, msg,
          `*🔤 Filtered Words for this chat (${words.length})*\n\n${words.map((w) => `• ${w}`).join("\n")}`
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
