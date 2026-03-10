import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { getSetting, setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
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

    // Keep only last MAX_HISTORY messages per chat — delete older ones
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

// ─── Claude API Call ──────────────────────────────────────────────────────────

async function askClaude(chatId, userMessage) {
  const history = await getHistory(chatId);
  const systemPrompt = cachedGetSetting(
    "ai_system_prompt",
    "You are a helpful WhatsApp bot assistant. Be concise, friendly, and helpful. Keep responses brief and suitable for WhatsApp."
  );

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const groqKey = cachedGetSetting("groq_api_key", null);
  if (!groqKey) throw new Error("Groq API key not set. Use !setgroqkey <key> to set it.");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) throw new Error("No response from Groq");

  // Save both sides to history
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
      "!ai What is the capital of France?",
      "!ai Write me a short poem about rain",
      "!ai Explain quantum physics simply",
    ],
    notes: "The AI remembers the last 20 messages in each chat.",
    handler: async (sock, msg, args, from, prefix) => {
      const aiActive = cachedGetSetting("ai_active", "true");
      if (aiActive !== "true") {
        return replyMsg(sock, from, msg, "🤖 AI chat is currently disabled.");
      }

      const groqKey = cachedGetSetting("groq_api_key", null);
      if (!groqKey) {
        return replyMsg(sock, from, msg, `❌ Groq API key not set. Admin must run ${prefix}setgroqkey <key> first.`);
      }

      const userMessage = args.join(" ");
      await reactMsg(sock, from, msg, "🤖");

      try {
        const reply = await askClaude(from, userMessage);
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

  setgroqkey: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set the Groq API key for AI chat",
    usage: "!setgroqkey <key>",
    examples: ["!setgroqkey gsk_xxxxxxxxxxxx"],
    notes: "Get your free key from console.groq.com",
    handler: async (sock, msg, args, from, prefix) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setgroqkey*

🔧 *Syntax:*
${prefix}setgroqkey <key>

📌 Get your free key from console.groq.com`
      );
      try {
        await setSetting("groq_api_key", key);
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Groq API key updated successfully.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setgroqkey`, err);
      }
    },
  },

  setaiprompt: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set a custom system prompt for the AI",
    usage: "!setaiprompt <prompt>",
    examples: ["!setaiprompt You are a customer support agent for Acme Store. Be professional and helpful."],
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
// Called from handler.js when someone replies to a bot message

export async function handleAiReply(sock, msg, from) {
  const aiActive = cachedGetSetting("ai_active", "true");
  if (aiActive !== "true") return false;
  if (!cachedGetSetting('groq_api_key', null)) return false;

  const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  const quotedFromMe = msg.message?.extendedTextMessage?.contextInfo?.fromMe;

  // Only trigger if replying to the bot's own message
  if (!quotedFromMe && quotedParticipant !== `${BOT_NUMBER}@s.whatsapp.net`) return false;

  const text = msg.message?.extendedTextMessage?.text?.trim();
  if (!text) return false;

  try {
    await reactMsg(sock, from, msg, "🤖");
    const reply = await askClaude(from, text);
    await replyMsg(sock, from, msg, reply);
    return true;
  } catch (err) {
    console.error("❌ AI reply error:", err.message);
    await replyMsg(sock, from, msg, `❌ AI error: ${err.message}`);
    return true;
  }
}
