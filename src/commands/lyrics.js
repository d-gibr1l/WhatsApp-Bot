import { replyMsg, reactMsg, failMsg } from "./helpers.js";

export const lyricsCommands = {
  lyrics: {
    adminOnly: false,
    requiresArgs: true,
    description: "Fetch lyrics for any song",
    usage: "!lyrics <song name>",
    examples: [
      "!lyrics faded",
      "!lyrics shape of you ed sheeran"
    ],
    handler: async (sock, msg, args, from, prefix) => {
      if (args.length === 0) {
        return replyMsg(sock, from, msg, `📖 *${prefix}lyrics <song name>*\n\nExample:\n• ${prefix}lyrics faded alan walker`);
      }

      const query = args.join(" ");
      await reactMsg(sock, from, msg, "🎵");

      try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error("API request failed");
        
        const data = await res.json();
        if (!data || data.length === 0 || !data[0].plainLyrics) {
          await reactMsg(sock, from, msg, "❌");
          return replyMsg(sock, from, msg, `❌ Couldn't find lyrics for *${query}*. Try adding the artist name.`);
        }

        const song = data[0];
        let lyrics = song.plainLyrics;
        const header = `🎤 *${song.trackName}*\n👤 *Artist:* ${song.artistName}\n💿 *Album:* ${song.albumName || "Unknown"}\n\n`;

        // WhatsApp has a 65k character limit, but it's good practice to truncate around 4000 just in case
        const MAX = 4000;
        if (lyrics.length > MAX) {
          lyrics = lyrics.slice(0, MAX) + "\n\n_...truncated (too long)_";
        }

        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, header + lyrics);

      } catch (err) {
        console.error("❌ lyrics error:", err.message);
        await failMsg(sock, from, msg, err, "lyrics");
      }
    },
  },
};
