import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { setSetting, supabase } from "../db.js";
import { cachedGetSetting, refreshSettings, isAiSentMessage, rememberAiSent } from "../cache.js";
import { botConfig } from "../config.js";

const MAX_HISTORY = 20;

// ─── Conversation history (Supabase) ─────────────────────────────────────────

async function getHistory(chatId) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY);
  if (error) throw new Error(`Failed to load conversation history: ${error.message}`);
  return data ?? [];
}

async function saveConversationTurn(chatId, userMessage, assistantReply) {
  try {
    await supabase.from("ai_conversations").insert([
      { chat_id: chatId, role: "user",      content: userMessage },
      { chat_id: chatId, role: "assistant", content: assistantReply },
    ]);
    const { data } = await supabase
      .from("ai_conversations")
      .select("id")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .range(MAX_HISTORY, 10000);
    if (data?.length) {
      await supabase.from("ai_conversations").delete().in("id", data.map((r) => r.id));
    }
  } catch (err) {
    console.error("❌ saveConversationTurn:", err.message);
  }
}

async function clearHistory(chatId) {
  await supabase.from("ai_conversations").delete().eq("chat_id", chatId);
}

// ─── Groq API Call ────────────────────────────────────────────────────────────

async function askGroq(chatId, userMessage) {
  const groqKey = cachedGetSetting("groq_api_key", null);
  if (!groqKey) throw new Error("Groq API key not set. Use !setgroqkey <key> to set it.");

  const systemPrompt = cachedGetSetting(
    "ai_system_prompt",
    "You are a helpful WhatsApp bot assistant. Be concise, friendly, and helpful. Keep responses brief and suitable for WhatsApp."
  );

  let history = [];
  try {
    history = await getHistory(chatId);
  } catch (err) {
    console.error("❌ Could not load history:", err.message);
    throw new Error("Could not load conversation history. Please try again.");
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Groq API error: ${res.status}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("No response from Groq.");

  saveConversationTurn(chatId, userMessage, reply);
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
    notes: "The AI remembers the last 20 messages in each chat. Powered by Groq (Llama 3.1).",
    handler: async (sock, msg, args, from, prefix) => {
      const aiActive = cachedGetSetting("ai_active", "true");
      if (aiActive !== "true") return replyMsg(sock, from, msg, "🤖 AI chat is currently disabled.");

      const groqKey = cachedGetSetting("groq_api_key", null);
      if (!groqKey) return replyMsg(sock, from, msg,
        `❌ Groq API key not set. Admin must run *${prefix}setgroqkey <key>* first.\n\n📌 Get a free key at: console.groq.com`
      );

      const userMessage = args.join(" ");
      reactMsg(sock, from, msg, "🤖").catch(() => {});

      try {
        const reply = await askGroq(from, userMessage);
        const sent = await replyMsg(sock, from, msg, reply);
        // Track this message ID so replies to it trigger AI again
        if (sent?.key?.id) rememberAiSent(sent.key.id);
      } catch (err) {
        console.error("❌ AI error:", err.message);
        await replyMsg(sock, from, msg, `❌ AI error: ${err.message}`);
        await alertOwner(sock, `${prefix}ai`, err);
      }
    },
  },

  clearai: {
    adminOnly: true,
    requiresArgs: false,
    description: "Clear the AI conversation history for this chat",
    handler: async (sock, msg, _args, from) => {
      try {
        await clearHistory(from);
        await replyMsg(sock, from, msg, "🗑️ AI conversation history cleared for this chat.");
      } catch (_err) {
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
    examples: ["!setgroqkey gsk_..."],
    notes: "Get your free key from console.groq.com",
    handler: async (sock, msg, args, from, prefix) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setgroqkey*\n\n🔧 *Syntax:*\n${prefix}setgroqkey <key>\n\n📌 Get your free key from console.groq.com`
      );
      try {
        await setSetting("groq_api_key", key);
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Groq API key saved. Try *!ai hello* to test.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setgroqkey`, err);
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
  if (!cachedGetSetting("groq_api_key", null)) return false;

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo) return false;

  const quotedId          = contextInfo.stanzaId ?? "";
  const quotedParticipant = contextInfo.participant ?? "";
  const botJid            = `${botConfig.BOT_NUMBER}@s.whatsapp.net`;

  const isReplyToBot =
    isAiSentMessage(quotedId) ||
    (quotedParticipant === botJid && !contextInfo.fromMe === false && isAiSentMessage(quotedId));

  if (!isReplyToBot) return false;

  const text = msg.message?.extendedTextMessage?.text?.trim();
  if (!text) return false;

  try {
    reactMsg(sock, from, msg, "🤖").catch(() => {});
    const reply = await askGroq(from, text);
    const sent = await replyMsg(sock, from, msg, reply);
    if (sent?.key?.id) rememberAiSent(sent.key.id);
    return true;
  } catch (err) {
    console.error("❌ AI reply error:", err.message);
    await replyMsg(sock, from, msg, `❌ AI error: ${err.message}`);
    return true;
  }
}
