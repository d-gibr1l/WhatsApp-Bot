import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { cachedGetSetting } from "../cache.js";
import { setSetting } from "../db.js";
import { refreshSettings } from "../cache.js";

async function tavilySearch(query, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      include_images: true,
      max_results: 5,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? err?.detail ?? `Tavily API error: ${res.status}`);
  }

  const data = await res.json();
  const answer  = data.answer ?? null;
  const sources = (data.results ?? []).slice(0, 3)
    .map((r) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 120) }));
  const imageUrl = data.images?.[0] ?? null;

  return { answer, sources, imageUrl };
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
    description: "Search the internet using Tavily AI",
    usage: "!search <query>",
    examples: [
      "!search latest news in Ghana today",
      "!search what is the price of Bitcoin",
      "!search who won the Champions League 2025",
    ],
    notes: "Powered by Tavily real-time web search.",
    handler: async (sock, msg, args, from, prefix) => {
      const query = args.join(" ").trim();
      if (!query) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}search*\n\n🔧 *Syntax:*\n${prefix}search <query>\n\n💡 *Examples:*\n• ${prefix}search latest news in Ghana\n• ${prefix}search Bitcoin price today`
      );

      const apiKey = cachedGetSetting("tavily_api_key", null);
      if (!apiKey) return replyMsg(sock, from, msg,
        `❌ Tavily API key not set.\n\n📌 Admin can set it with: *${prefix}settavilykey <key>*\n\n🌐 Get a free key at: tavily.com`
      );

      await reactMsg(sock, from, msg, "🔍");

      try {
        const { answer, sources, imageUrl } = await tavilySearch(query, apiKey);

        let caption = `🔍 *${query}*\n\n`;

        if (answer) {
          caption += answer;
        } else if (sources.length > 0) {
          caption += sources.map(s => `*${s.title}*\n${s.snippet}...`).join("\n\n");
        } else {
          caption += "No results found.";
        }

        if (sources.length > 0) {
          caption += `\n\n🌐 *Sources:*\n${sources.map((s, i) => `${i + 1}. ${s.url}`).join("\n")}`;
        }

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

  settavilykey: {
    adminOnly: true,
    requiresArgs: false,
    description: "Set the Tavily API key for web search",
    usage: "!settavilykey <key>",
    examples: ["!settavilykey tvly-xxxxxxxxxxxx"],
    handler: async (sock, msg, args, from, prefix) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}settavilykey*\n\n🔧 *Syntax:*\n${prefix}settavilykey <key>\n\n📌 Get your free key at: tavily.com`
      );
      try {
        await setSetting("tavily_api_key", key);
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ Tavily API key saved. *!search* is now active.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ Failed to save key: ${err.message}`);
        await alertOwner(sock, `${prefix}settavilykey`, err);
      }
    },
  },

};
