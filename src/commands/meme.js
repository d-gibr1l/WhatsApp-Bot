import { replyMsg, reactMsg } from "./helpers.js";

export const memeCommands = {
  meme: {
    adminOnly: false,
    requiresArgs: false,
    description: "Get a random highly-upvoted meme from Reddit",
    usage: "!meme [subreddit]",
    examples: [
      "!meme",
      "!meme dankmemes",
      "!meme programmerhumor"
    ],
    notes: "Defaults to popular meme subreddits if no subreddit is provided.",
    handler: async (sock, msg, args, from, _prefix) => {
      await reactMsg(sock, from, msg, "😂");

      const subreddit = args[0] ? args[0].replace(/r\//i, "") : "";
      const url = subreddit ? `https://meme-api.com/gimme/${subreddit}` : "https://meme-api.com/gimme";

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch meme");
        
        const data = await res.json();
        
        if (data.code || data.message) {
          throw new Error(data.message || "Subreddit not found or has no memes");
        }

        const caption = `*${data.title}*\n_r/${data.subreddit} (👍 ${data.ups})_`;

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          image: { url: data.url },
          caption
        }, { quoted: msg });

      } catch (err) {
        console.error("❌ meme error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Couldn't fetch a meme: ${err.message}`);
      }
    },
  },
};
