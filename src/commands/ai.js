import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { getSetting, setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings, isBotSentMessage } from "../cache.js";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY, BOT_NUMBER } from "../config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const MAX_HISTORY = 20;

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function getHistory(chatId) {
  try {
    const { data, error } = await supabase
      .from("ai_conversations")
      .select("role, content")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true })
      .limit(MAX_HISTORY);
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    console.error("❌ getHistory:", err.message);
    return [];
  }
}

async function saveMessage(chatId, role, content) {
  try {
    await supabase.from("ai_conversations").insert({ chat_id: chatId, role, content });

    const { data } = await supabase
      .from("ai_conversations")
      .select("id")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .range(MAX_HISTORY, 1000);

    if (data?.length) {
      const ids = data.map((r) => r.id);
      await supabase.from("ai_conversations").delete().in("id", ids);
    }
  } catch (err) {
    console.error("❌ saveMessage:", err.message);
  }
}

async function clearHistory(chatId) {
  await supabase.from("ai_conversations").delete().eq("chat_id", chatId);
}

// ─── Gemini API Call ──────────────────────────────────────────────────────────

async function askGemini(chatId, userMessage) {
  const geminiKey = cachedGetSetting("gemini_api_key", null);
  if (!geminiKey) throw new Error("Gemini API key not set. Use !setgeminikey <key> to set it.");

  const systemPrompt = cachedGetSetting(
    "ai_system_prompt",
    "You are a helpful WhatsApp bot assistant. Be concise, friendly, and helpful. Keep responses brief and suitable for WhatsApp."
  );

  const history = await getHistory(chatId);

  // Build Gemini contents array from history
  const contents = [
    // Inject system prompt as first user/model exchange
    { role: "user",  parts: [{ text: `[System]: ${systemPrompt}` }] },
    { role: "model", parts: [{ text: "Understood. I will follow those instructions." }] },
    // Conversation history
    ...history.map((h) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    })),
    // Current message
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Gemini API error: ${res.status}`);
  }

  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) throw new Error("No response from Gemini.");

  // Save to history
  await saveMessage(chatId, "user", userMessage);
  await saveMessage(chatId, "assistant", reply);

  return reply;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const aiCommands = {

  ai: {
    adminOnly: false,
    requiresArgs: true,
    description: "Chat with the AI assistant (remembers conversation context)",
    usage: "!ai <message>",
    examples: [
      "!ai What is the capital of Ghana?",
      "!ai Write me a short poem about rain",
      "!ai Explain quantum physics simply",
    ],
    notes: "The AI remembers the last 20 messages in each chat. Powered by Google Gemini.",
    handler: async (sock, msg, args, from, prefix) => {
      const aiActive = cachedGetSetting("ai_active", "true");
      if (aiActive !== "true") return replyMsg(sock, from, msg, "🤖 AI chat is currently disabled.");

      const geminiKey = cachedGetSetting("gemini_api_key", null);
      if (!geminiKey) return replyMsg(sock, from, msg,
        `❌ Gemini API key not set. Admin must run *${prefix}setgeminikey <key>* first.`
      );

      const userMessage = args.join(" ");
      await reactMsg(sock, from, msg, "🤖");

      try {
        const reply = await askGemini(from, userMessage);
        await replyMsg(sock, from, msg, reply);
      } catch (err) {
        console.error("❌ AI error:", err.message);
        await replyMsg(sock, from, msg, `❌ AI error: ${err.message}`);
        await alertOwner(sock, `${prefix}ai`, err);
      }
    },
  },

  clearai: {
    adminOnly: false,
    requiresArgs: false,
    description: "Clear the AI conversation history for this chat",
    handler: async (sock, msg, _args, from) => {
      try {
        await clearHistory(from);
        await replyMsg(sock, from, msg, "🗑️ AI conversation history cleared for this chat.");
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to clear history.");
      }
    },
  },

  aion: {
    adminOnly: true,
    requiresArgs: false,
    description: "Enable AI chat",
    handler: async (sock, msg, _args, from) => {
      await setSetting("ai_active", "true");
      await refreshSettings();
      await replyMsg(sock, from, msg, "✅ AI chat enabled.");
    },
  },

  aioff: {
    adminOnly: true,
    requiresArgs: false,
    description: "Disable AI chat",
    handler: async (sock, msg, _args, from) => {
      await setSetting("ai_active", "false");
      await refreshSettings();
      await replyMsg(sock, from, msg, "🔴 AI chat disabled.");
    },
  },

  setgeminikey: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set the Google Gemini API key for AI chat and search",
    usage: "!setgeminikey <key>",
    examples: ["!setgeminikey AIzaSy..."],
    notes: "Get your free key from aistudio.google.com",
    handler: async (sock, msg, args, from, prefix) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setgeminikey*\n\n🔧 *Syntax:*\n${prefix}setgeminikey <key>\n\n📌 Get your free key from aistudio.google.com`
      );
      try {
        await setSetting("gemini_api_key", key);
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Gemini API key saved. Try *!ai hello* to test.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setgeminikey`, err);
      }
    },
  },

  setaiprompt: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set a custom system prompt for the AI personality",
    usage: "!setaiprompt <prompt>",
    examples: ["!setaiprompt You are a customer support agent for Acme Store. Be professional."],
    notes: "This sets the AI's personality and behavior.",
    handler: async (sock, msg, args, from, prefix) => {
      try {
        await setSetting("ai_system_prompt", args.join(" "));
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ AI system prompt updated.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setaiprompt`, err);
      }
    },
  },

};

// ─── Reply-to-bot trigger ─────────────────────────────────────────────────────

export async function handleAiReply(sock, msg, from) {
  const aiActive = cachedGetSetting("ai_active", "true");
  if (aiActive !== "true") return false;
  if (!cachedGetSetting("gemini_api_key", null)) return false;

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo) return false;

  // Only trigger if the quoted message was actually sent by the bot.
  // We check the stanzaId against our tracked sent-message IDs.
  // This prevents triggering when someone replies to a human's message.
  const quotedId          = contextInfo.stanzaId ?? "";
  const quotedParticipant = contextInfo.participant ?? "";
  const botJid            = `${BOT_NUMBER}@s.whatsapp.net`;

  const isReplyToBot =
    isBotSentMessage(quotedId) ||                          // bot sent it (DM or group)
    quotedParticipant === botJid ||                        // group: quoted sender is bot
    quotedParticipant.split("@")[0] === BOT_NUMBER;        // group: number matches

  if (!isReplyToBot) return false;

  const text = msg.message?.extendedTextMessage?.text?.trim();
  if (!text) return false;

  try {
    await reactMsg(sock, from, msg, "🤖");
    const reply = await askGemini(from, text);
    await replyMsg(sock, from, msg, reply);
    return true;
  } catch (err) {
    console.error("❌ AI reply error:", err.message);
    await replyMsg(sock, from, msg, `❌ AI error: ${err.message}`);
    return true;
  }
}
