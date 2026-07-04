import { reactMsg, replyMsg } from "./helpers.js";
import { botConfig } from "../config.js";

export const imdbCommands = {
  imdb: {
    adminOnly: false,
    requiresArgs: true,
    description: "Search for a movie or TV show on IMDb",
    usage: "!imdb <title>",
    example: "!imdb inception",
    handler: async (sock, msg, args, from) => {
      const apiKey = botConfig.OMDB_API_KEY || process.env.OMDB_API_KEY;
      
      if (!apiKey) {
        await replyMsg(sock, from, msg, "❌ The OMDB API key is missing! The bot owner must set it using: `!setconfig OMDB_API_KEY <key>`");
        return;
      }

      const query = args.join(" ");
      await reactMsg(sock, from, msg, "⏳");

      try {
        const response = await fetch(`http://www.omdbapi.com/?apikey=${apiKey}&t=${encodeURIComponent(query)}`);
        const data = await response.json();

        if (data.Response === "False") {
          await replyMsg(sock, from, msg, `❌ Movie not found: ${data.Error}`);
          await reactMsg(sock, from, msg, "❌");
          return;
        }

        const caption = `🎬 *${data.Title} (${data.Year})* \n⭐ *IMDb Rating:* ${data.imdbRating}/10 ⏳ *Runtime:* ${data.Runtime} \n🎭 *Genre:* ${data.Genre} \n👤 *Director:* ${data.Director} \n👥 *Cast:* ${data.Actors}\n\n📝 *Plot:* ${data.Plot}`;

        if (data.Poster && data.Poster !== "N/A") {
          await sock.sendMessage(from, {
            image: { url: data.Poster },
            caption: caption
          }, { quoted: msg });
        } else {
          await replyMsg(sock, from, msg, caption);
        }

        await reactMsg(sock, from, msg, "✅");
      } catch (err) {
        console.error("IMDb search error:", err);
        await replyMsg(sock, from, msg, "❌ Failed to search IMDb. Please try again later.");
        await reactMsg(sock, from, msg, "❌");
      }
    }
  }
};
