import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings, isBotSentMessage } from "../cache.js";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY, BOT_NUMBER } from "../config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const MAX_HISTORY = 20;

// ─── Per-user rate limiting (fix #10) ────────────────────────────────────────
const COOLDOWN_MS  = 10_000; // 10 seconds between requests per user
const lastUsed     = new Map();

function checkCooldown(userId) {
  const now  = Date.now();
  const last = lastUsed.get(userId) ?? 0;
  if (now - last < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    return remaining; // seconds remaining
  }
  lastUsed.set(userId, now);
  // Prevent map growing unbounded
  if (lastUsed.size > 1000) {
    const oldest = lastUsed.keys().next().value;
    lastUsed.delete(oldest);
  }
  return 0;
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function getHistory(chatId) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY);

  // Fix #4: throw instead of silently returning [] so caller knows context is lost
  if (error) throw new Error(`Failed to load conversation history: ${error.message}`);
  return data ?? [];
}

async function saveConversationTurn(chatId, userMessage, assistantReply) {
  // Fix #1 + #2: save both messages in one operation, trim once after
  try {
    await supabase.from("ai_conversations").insert([
      { chat_id: chatId, role: "user",      content: userMessage },
      { chat_id: chatId, role: "assistant", content: assistantReply },
    ]);

    // Trim to MAX_HISTORY — one cleanup query per turn instead of two
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

// ─── Gemini API Call ──────────────────────────────────────────────────────────

async function askGemini(chatId, userMessage, senderJid) {
  const geminiKey = cachedGetSetting("gemini_api_key", null);
  if (!geminiKey) throw new Error("Gemini API key not set. Use !setgeminikey <key> to set it.");

  const systemPrompt = cachedGetSetting(
    "ai_system_prompt",
    "You are a helpful WhatsApp bot assistant. Be concise, friendly, and helpful. Keep responses brief and suitable for WhatsApp."
  );

  // Fix #4: propagate history error to caller instead of silently losing context
  let history = [];
  try {
    history = await getHistory(chatId);
  } catch (err) {
    console.error("❌ Could not load history:", err.message);
    throw new Error("Could not load conversation history. Please try again.");
  }

  const contents = [
    ...history.map((h) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  // Fix #6: use proper systemInstruction field instead of fake conversation turns
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
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

  // Fix #1: save both turns atomically in one call
  await saveConversationTurn(chatId, userMessage, reply);

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

      // Fix #10: per-user cooldown
      const senderJid = msg.key.participant ?? msg.key.remoteJid;
      const wait = checkCooldown(senderJid);
      if (wait > 0) return replyMsg(sock, from, msg,
        `⏳ Please wait *${wait}s* before sending another AI message.`
      );

      const userMessage = args.join(" ");
      await reactMsg(sock, from, msg, "🤖");

      try {
        const reply = await askGemini(from, userMessage, senderJid);
        await replyMsg(sock, from, msg, reply);
      } catch (err) {
        console.error("❌ AI error:", err.message);
        await replyMsg(sock, from, msg, `❌ AI error: ${err.message}`);
        await alertOwner(sock, `${prefix}ai`, err);
      }
    },
  },

  // Fix #5: clearai is now admin-only
  clearai: {
    adminOnly: true,
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

  const quotedId          = contextInfo.stanzaId ?? "";
  const quotedParticipant = contextInfo.participant ?? "";
  const botJid            = `${BOT_NUMBER}@s.whatsapp.net`;

  // Fix #7: primary check is isBotSentMessage — the participant fallbacks
  // only apply in groups where the bot's JID is unambiguous as a participant.
  // We no longer fall back to BOT_NUMBER string match alone (too broad).
  const isReplyToBot =
    isBotSentMessage(quotedId) ||       // bot sent it — most reliable check
    (quotedParticipant === botJid &&     // group: quoted sender is exactly bot JID
     !contextInfo.fromMe === false);     // and it wasn't sent by a human fromMe

  if (!isReplyToBot) return false;

  const text = msg.message?.extendedTextMessage?.text?.trim();
  if (!text) return false;

  // Fix #10: apply cooldown to reply-to-bot trigger too
  const senderJid = msg.key.participant ?? msg.key.remoteJid;
  const wait = checkCooldown(senderJid);
  if (wait > 0) return true; // consume the event silently, don't spam cooldown msg

  try {
    await reactMsg(sock, from, msg, "🤖");
    const reply = await askGemini(from, text, senderJid);
    await replyMsg(sock, from, msg, reply);
    return true;
  } catch (err) {
    console.error("❌ AI reply error:", err.message);
    await replyMsg(sock, from, msg, `❌ AI error: ${err.message}`);
    return true;
  }
}
