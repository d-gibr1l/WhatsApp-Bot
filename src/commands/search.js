import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { cachedGetSetting } from "../cache.js";
import { setSetting } from "../db.js";
import { refreshSettings } from "../cache.js";

async function braveSearch(query, apiKey) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.append("q", query);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? err?.detail ?? `Brave Search API error: ${res.status}`);
  }

  const data = await res.json();
  const answer = null; // Brave doesn't provide a direct AI answer in the standard web search endpoint
  
  // Extract web results
  const webResults = data.web?.results ?? [];
  const sources = webResults.slice(0, 5).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description
  }));

  return { answer, sources, imageUrl: null };
}

async function summarizeWithAi(query, sources) {
  if (!sources || sources.length === 0) return "No results found.";

  const geminiKey = cachedGetSetting("gemini_api_key", null);
  const groqKey = cachedGetSetting("groq_api_key", null);

  const contextText = sources
    .map((s, i) => `[Result ${i + 1}]: ${s.title}\n${s.snippet}`)
    .join("\n\n");

  const prompt = `You are a search assistant. The user searched for: "${query}".
Below are real-time search results retrieved from the web:

${contextText}

Synthesize a clear, concise, direct answer based strictly on these search results. Format nicely using WhatsApp markdown (*bold*, bullet points •, emojis). Do NOT list raw web sources, links, or URL references at the end.`;

  // 1. Try Gemini
  if (geminiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      }
    } catch (err) {
      console.error("❌ Gemini search summarization error:", err.message);
    }
  }

  // 2. Try Groq
  if (groqKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
          temperature: 0.5,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch (err) {
      console.error("❌ Groq search summarization error:", err.message);
    }
  }

  // 3. Fallback: Clean bulleted list if no AI keys are available
  return sources.map(s => `• *${s.title}*\n${s.snippet}`).join("\n\n");
}

async function fetchImageBuffer(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("Not an image");
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

export const searchCommands = {

  search: {
    adminOnly: false,
    requiresArgs: true,
    description: "Search the internet using Brave Search",
    usage: "!search <query>",
    examples: [
      "!search latest news in Ghana today",
      "!search what is the price of Bitcoin",
      "!search who won the Champions League 2025",
    ],
    notes: "Powered by Brave real-time web search.",
    handler: async (sock, msg, args, from, prefix) => {
      const query = args.join(" ").trim();
      if (!query) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}search*\n\n🔧 *Syntax:*\n${prefix}search <query>\n\n💡 *Examples:*\n• ${prefix}search latest news in Ghana\n• ${prefix}search Bitcoin price today`
      );

      const apiKey = cachedGetSetting("brave_api_key", null);
      if (!apiKey) return replyMsg(sock, from, msg,
        `❌ Brave API key not set.\n\n📌 Admin can set it with: *${prefix}setbravekey <key>*\n\n🌐 Get a key at: search.brave.com`
      );

      await reactMsg(sock, from, msg, "🔍");

      try {
        const { answer: directAnswer, sources, imageUrl } = await braveSearch(query, apiKey);

        const summary = directAnswer || await summarizeWithAi(query, sources);
        const caption = `🔍 *${query}*\n\n${summary}`;

        // Try to send with image, fall back to text-only if image fails
        if (imageUrl) {
          try {
            const { buffer, contentType } = await fetchImageBuffer(imageUrl);
            await sock.sendMessage(from, {
              image: buffer,
              caption,
              mimetype: contentType,
            }, { quoted: msg });
            await reactMsg(sock, from, msg, "✅");
            return;
          } catch {
            // Image failed — fall through to plain text
          }
        }

        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, caption);

      } catch (err) {
        console.error("❌ Search error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Search failed: ${err.message}`);
        await alertOwner(sock, `${prefix}search`, err);
      }
    },
  },

  setbravekey: {
    adminOnly: true,
    requiresArgs: false,
    description: "Set the Brave API key for web search",
    usage: "!setbravekey <key>",
    examples: ["!setbravekey BSAxxxxxxxxxxxx"],
    handler: async (sock, msg, args, from, prefix) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setbravekey*\n\n🔧 *Syntax:*\n${prefix}setbravekey <key>\n\n📌 Get your key at: search.brave.com`
      );
      try {
        await setSetting("brave_api_key", key);
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Brave API key saved. *!search* is now active.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ Failed to save key: ${err.message}`);
        await alertOwner(sock, `${prefix}setbravekey`, err);
      }
    },
  },

};
