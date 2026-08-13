import axios from "axios";

let mergedCommands = ["movie", "movies", "imdb", "tmdb"];

export default {
  name: "movies",
  alias: [...mergedCommands],
  uniquecommands: ["movie", "imdb"],
  description: "Search for a movie or TV show on IMDb (via TMDB)",
  start: async (Hooper, m, { inputCMD, text, doReact, prefix }) => {
    try {
      if (!text) {
        await doReact("❔");
        return m.reply(
          `Please provide a movie or TV show name!\n\nExample: *${prefix}movie Inception*`
        );
      }

      const apiKey = global.tmdbAPIKey || process.env.TMDB_API_KEY;
      if (!apiKey) {
        await doReact("❌");
        return m.reply(
          `❌ The TMDB API key is missing! The bot owner must add it via the Settings Dashboard or \`TMDB_API_KEY\` in the .env file.\n\nGet a free key from themoviedb.org/settings/api`
        );
      }

      await doReact("⏳");

      // Step 1: Search for the title
      const searchRes = await axios.get(
        `https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${encodeURIComponent(
          text
        )}`
      );
      const searchData = searchRes.data;

      // Filter out people, only keep movies and TV shows
      const results =
        searchData.results?.filter(
          (r) => r.media_type === "movie" || r.media_type === "tv"
        ) || [];

      if (results.length === 0) {
        await doReact("❌");
        return m.reply(`❌ Movie or TV show not found for: *${text}*`);
      }

      const topResult = results[0];
      const mediaType = topResult.media_type;
      const id = topResult.id;

      // Step 2: Fetch full details including cast (credits)
      const detailsRes = await axios.get(
        `https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${apiKey}&append_to_response=credits`
      );
      const data = detailsRes.data;

      // Extract and format details
      const title = data.title || data.name;
      const year = (data.release_date || data.first_air_date || "").split(
        "-"
      )[0];
      const rating = (data.vote_average || 0).toFixed(1);

      let runtime = "N/A";
      if (data.runtime) {
        runtime = `${data.runtime} min`;
      } else if (data.episode_run_time && data.episode_run_time.length > 0) {
        runtime = `${data.episode_run_time[0]} min`;
      }

      const genres = (data.genres || []).map((g) => g.name).join(", ");

      // Find Director (or Creator for TV)
      let director = "Unknown";
      if (mediaType === "tv" && data.created_by && data.created_by.length > 0) {
        director = data.created_by.map((c) => c.name).join(", ");
      } else if (data.credits && data.credits.crew) {
        const dirs = data.credits.crew.filter((c) => c.job === "Director");
        if (dirs.length > 0) director = dirs.map((d) => d.name).join(", ");
      }

      // Get Top 3 Cast members
      let cast = "Unknown";
      if (data.credits && data.credits.cast && data.credits.cast.length > 0) {
        cast = data.credits.cast
          .slice(0, 3)
          .map((a) => a.name)
          .join(", ");
      }

      const overview = data.overview || "No plot available.";

      const caption = `🎬 *${title} (${year})*\n⭐ *IMDb Rating:* ${rating}/10\n⏳ *Runtime:* ${runtime}\n🎭 *Genre:* ${genres}\n👤 *Director:* ${director}\n👥 *Cast:* ${cast}\n\n📝 *Plot:* ${overview}`;

      if (data.poster_path) {
        const posterUrl = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
        await Hooper.sendMessage(
          m.from,
          {
            image: { url: posterUrl },
            caption: caption,
          },
          { quoted: m }
        );
      } else {
        await m.reply(caption);
      }

      await doReact("✅");
    } catch (err) {
      console.error("[ MOVIES ] Error:", err.message);
      await doReact("❌");
      m.reply(`❌ Failed to search for the movie. Please try again later.`);
    }
  },
};
