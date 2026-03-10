import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { getSetting } from "../db.js";

// ─── Google TTS ───────────────────────────────────────────────────────────────

async function textToSpeech(text, lang = "en") {
  const encoded = encodeURIComponent(text.slice(0, 200));
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Referer": "https://translate.google.com/",
    },
  });

  if (!res.ok) throw new Error(`Google TTS error: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

// ─── AI + TTS combined ────────────────────────────────────────────────────────

async function getAiResponse(prompt, groqKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 200, // keep short for voice
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant. Keep responses short and conversational — under 3 sentences. No markdown, no bullet points, just plain speech.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "I could not generate a response.";
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const voiceCommands = {

  voice: {
    adminOnly: false,
    requiresArgs: true,
    description: "Ask AI a question and get a voice note reply",
    usage: "!voice <message>",
    examples: ["!voice What is the capital of Ghana?", "!voice Tell me a joke"],
    handler: async (sock, msg, args, from, prefix) => {
      const prompt = args.join(" ").trim();
      if (!prompt) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}voice*\n\n🔧 *Syntax:*\n${prefix}voice <message>\n\n💡 *Example:*\n• ${prefix}voice Tell me a joke`
      );

      await reactMsg(sock, from, msg, "🎙️");

      try {
        const groqKey = await getSetting("groq_api_key", null);
        if (!groqKey) return replyMsg(sock, from, msg,
          `❌ Groq API key not set. Admin can set it with: *!setgroqkey <key>*`
        );

        // Get AI response
        const aiText = await getAiResponse(prompt, groqKey);

        // Convert to speech
        const audioBuffer = await textToSpeech(aiText);

        await reactMsg(sock, from, msg, "✅");

        // Send as voice note (ptt = push to talk)
        await sock.sendMessage(from, {
          audio: audioBuffer,
          mimetype: "audio/mpeg",
          ptt: true,
        }, { quoted: msg });

        // Also send text so user can read it
        await replyMsg(sock, from, msg, `💬 _${aiText}_`);

      } catch (err) {
        console.error("❌ Voice error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Voice reply failed: ${err.message}`);
        await alertOwner(sock, `${prefix}voice`, err);
      }
    },
  },

  tts: {
    adminOnly: false,
    requiresArgs: true,
    description: "Convert any text to a voice note",
    usage: "!tts <text>",
    examples: ["!tts Hello everyone!", "!tts Good morning"],
    handler: async (sock, msg, args, from, prefix) => {
      const text = args.join(" ").trim();
      if (!text) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}tts*\n\n🔧 *Syntax:*\n${prefix}tts <text>`
      );

      await reactMsg(sock, from, msg, "🎙️");

      try {
        const audioBuffer = await textToSpeech(text);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          audio: audioBuffer,
          mimetype: "audio/mpeg",
          ptt: true,
        }, { quoted: msg });

      } catch (err) {
        console.error("❌ TTS error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ TTS failed: ${err.message}`);
        await alertOwner(sock, `${prefix}tts`, err);
      }
    },
  },

};
