import { reactMsg, replyMsg } from "./helpers.js";
import { botConfig } from "../config.js";
import { cachedGetSetting } from "../cache.js";

export const imdbCommands = {
  imdb: {
    adminOnly: false,
    requiresArgs: true,
    description: "Search for a movie or TV show on IMDb (via TMDB)",
    usage: "<prefix>imdb <title>",
    example: "<prefix>imdb inception",
    handler: async (sock, msg, args, from, prefix) => {
      const apiKey = cachedGetSetting("tmdb_api_key", null) || botConfig.TMDB_API_KEY || process.env.TMDB_API_KEY;
      
      if (!apiKey) {
        await replyMsg(sock, from, msg, `❌ The TMDB API key is missing! The bot owner must set it using: \`${prefix}settmdbkey <key>\``);
        return;
      }

      const query = args.join(" ");
      await reactMsg(sock, from, msg, "⏳");

      try {
        // Step 1: Search for the title
        const searchRes = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${encodeURIComponent(query)}`);
        const searchData = await searchRes.json();

        // Filter out people, only keep movies and TV shows
        const results = searchData.results?.filter(r => r.media_type === "movie" || r.media_type === "tv") || [];

        if (results.length === 0) {
          await replyMsg(sock, from, msg, `❌ Movie or TV show not found.`);
          await reactMsg(sock, from, msg, "❌");
          return;
        }

        const topResult = results[0];
        const mediaType = topResult.media_type;
        const id = topResult.id;

        // Step 2: Fetch full details including cast (credits)
        const detailsRes = await fetch(`https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${apiKey}&append_to_response=credits`);
        const data = await detailsRes.json();

        // Extract and format details
        const title = data.title || data.name;
        const year = (data.release_date || data.first_air_date || "").split("-")[0];
        const rating = (data.vote_average || 0).toFixed(1);
        
        let runtime = "N/A";
        if (data.runtime) {
          runtime = `${data.runtime} min`;
        } else if (data.episode_run_time && data.episode_run_time.length > 0) {
          runtime = `${data.episode_run_time[0]} min`;
        }

        const genres = (data.genres || []).map(g => g.name).join(", ");
        
        // Find Director (or Creator for TV)
        let director = "Unknown";
        if (mediaType === "tv" && data.created_by && data.created_by.length > 0) {
          director = data.created_by.map(c => c.name).join(", ");
        } else if (data.credits && data.credits.crew) {
          const dirs = data.credits.crew.filter(c => c.job === "Director");
          if (dirs.length > 0) director = dirs.map(d => d.name).join(", ");
        }

        // Get Top 3 Cast members
        let cast = "Unknown";
        if (data.credits && data.credits.cast && data.credits.cast.length > 0) {
          cast = data.credits.cast.slice(0, 3).map(a => a.name).join(", ");
        }

        const overview = data.overview || "No plot available.";

        const caption = `🎬 *${title} (${year})* \n⭐ *IMDb Rating:* ${rating}/10 ⏳ *Runtime:* ${runtime} \n🎭 *Genre:* ${genres} \n👤 *Director:* ${director} \n👥 *Cast:* ${cast}\n\n📝 *Plot:* ${overview}`;

        if (data.poster_path) {
          const posterUrl = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
          await sock.sendMessage(from, {
            image: { url: posterUrl },
            caption: caption
          }, { quoted: msg });
        } else {
          await replyMsg(sock, from, msg, caption);
        }

        await reactMsg(sock, from, msg, "✅");
      } catch (err) {
        console.error("TMDB search error:", err);
        await replyMsg(sock, from, msg, "❌ Failed to search. Please try again later.");
        await reactMsg(sock, from, msg, "❌");
      }
    }
  }
};
