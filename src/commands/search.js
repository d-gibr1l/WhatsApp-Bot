import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { cachedGetSetting } from "../cache.js";

async function geminiSearch(query, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Gemini API error: ${res.status}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  if (!text) throw new Error("No response from Gemini.");

  // Extract grounding sources if available
  const sources = data.candidates?.[0]?.groundingMetadata?.groundingChunks
    ?.map((c) => c.web?.uri)
    .filter(Boolean)
    .slice(0, 3) ?? [];

  return { text, sources };
}

export const searchCommands = {

  search: {
    adminOnly: false,
    requiresArgs: true,
    description: "Search the internet using Google Gemini AI",
    usage: "!search <query>",
    examples: [
      "!search latest news in Ghana today",
      "!search what is the price of Bitcoin",
      "!search who won the Champions League 2025",
    ],
    notes: "Powered by Google Gemini with real-time Google Search.",
    handler: async (sock, msg, args, from, prefix) => {
      const query = args.join(" ").trim();
      if (!query) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}search*\n\n🔧 *Syntax:*\n${prefix}search <query>\n\n💡 *Examples:*\n• ${prefix}search latest news in Ghana\n• ${prefix}search Bitcoin price today`
      );

      const apiKey = cachedGetSetting("gemini_api_key", null);
      if (!apiKey) return replyMsg(sock, from, msg,
        `❌ Gemini API key not set.\n\n📌 Admin can set it with: *${prefix}setgeminikey <key>*`
      );

      await reactMsg(sock, from, msg, "🔍");

      try {
        const { text, sources } = await geminiSearch(query, apiKey);

        let reply = `🔍 *Search: ${query}*\n\n${text}`;

        if (sources.length > 0) {
          reply += `\n\n🌐 *Sources:*\n${sources.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
        }

        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, reply);

      } catch (err) {
        console.error("❌ Search error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Search failed: ${err.message}`);
        await alertOwner(sock, `${prefix}search`, err);
      }
    },
  }

};

