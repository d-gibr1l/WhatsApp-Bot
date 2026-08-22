import axios from "axios";
import yts from "youtube-yts";
import { searchit } from "@fantox01/search-it";
import { ringtone } from "../System/Scrapers.js";
import { Sticker, StickerTypes } from "wa-sticker-formatter";


let mergedCommands = [
  "google",
  "search",
  "youtubesearch",
  "ringtone",
  "weather",
  "github",
  "gh",
  "wikipedia",
  "wiki",
  "anime",
  "animeinfo",
];

export default {
  name: "searches",
  alias: [...mergedCommands],
  uniquecommands: [
    "google",
    "ringtone",
    "weather",
    "github",
    "wikipedia",
    "anime",
  ],
  description: "All search related commands",
  start: async (Hooper, m, { inputCMD, text, doReact, prefix, pushName }) => {
    switch (inputCMD) {
      case "google":
      case "search":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide an image Search Term !\n\nExample: *${prefix}search Free Web development Course*`,
          );
        }
        await doReact("🔍");
        try {
          const googleSearch = await searchit(text, 10);
          if (!googleSearch || googleSearch.length === 0) {
            await doReact("❌");
            return m.reply(`No results found for: *${text}*`);
          }
          let resText = `  *『  ⚡️ Google Search Engine ⚡️  』*\n\n\n_🔍 Search Term:_ *${text}*\n\n\n`;
          for (const result of googleSearch) {
            resText += `_📍 Result:_ *${result.index + 1}*\n\n_🎀 Title:_ *${result.page}*\n\n_🔶 Description:_ *${result.desc}*\n\n_🔷 Link:_ *${result.url}*\n\n\n`;
          }
          await Hooper.sendMessage(
            m.from,
            {
              video: {
                url: "https://media.tenor.com/3aaAzbTrTMwAAAPo/google-technology-company.mp4",
              },
              gifPlayback: true,
              caption: resText,
            },
            { quoted: m },
          );
        } catch (err) {
          console.error("Search error:", err);
          await doReact("❌");
          return m.reply(`An error occurred while searching for: *${text}*`);
        }
        break;

      case "anime":
      case "animeinfo":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide an anime name!\n\nExample: *${prefix}anime One Piece*`
          );
        }
        await doReact("🌸");
        try {
          const query = `query ($search: String) { 
            Media (search: $search, type: ANIME) { 
              title { romaji english } 
              type episodes status averageScore 
              coverImage { large } 
              description siteUrl 
              startDate { year month day } 
            } 
          }`;
          
          const animeRes = await axios.post("https://graphql.anilist.co", {
            query: query,
            variables: { search: text }
          });
          
          if (!animeRes.data || !animeRes.data.data || !animeRes.data.data.Media) {
            await doReact("❌");
            return m.reply(`No anime found for: *${text}*`);
          }
          
          const anime = animeRes.data.data.Media;
          
          let resText = `  *『  🌸 Anime Details 🌸  』*\n\n\n`;
          resText += `_🎀 Title:_ *${anime.title.romaji}*\n`;
          if (anime.title.english) resText += `_📝 English:_ *${anime.title.english}*\n`;
          resText += `_🎬 Type:_ *${anime.type || 'Unknown'}*\n`;
          resText += `_📺 Episodes:_ *${anime.episodes || 'Unknown'}*\n`;
          resText += `_📌 Status:_ *${anime.status}*\n`;
          resText += `_⭐ Score:_ *${anime.averageScore ? anime.averageScore + '/100' : 'N/A'}*\n`;
          const airedDate = anime.startDate ? `${anime.startDate.year}-${anime.startDate.month}-${anime.startDate.day}` : 'Unknown';
          resText += `_📅 Aired:_ *${airedDate}*\n\n`;
          
          let synopsis = anime.description ? anime.description.replace(/<[^>]+>/g, '') : 'No synopsis available.';
          resText += `_📖 Synopsis:_ ${synopsis.length > 500 ? synopsis.slice(0, 500) + '...' : synopsis}\n\n`;
          resText += `_🔗 URL:_ ${anime.siteUrl}\n`;

          await Hooper.sendMessage(
            m.from,
            {
              image: { url: anime.coverImage.large },
              caption: resText,
            },
            { quoted: m }
          );
        } catch (e) {
          await doReact("❌");
          m.reply(`Anime search failed: ${e.response?.data?.errors?.[0]?.message || e.message}`);
        }
        break;

      

      

      case "ringtone":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide an ringtone Search Term !\n\nExample: *${prefix}ringtone iphone*`,
          );
        }
        await doReact("🎶");
        let resultRT = await ringtone(text);
        let resultR = resultRT[Math.floor(Math.random() * resultRT.length)];
        Hooper.sendMessage(
          m.from,
          {
            audio: { url: resultR.audio },
            fileName: text + ".mp3",
            mimetype: "audio/mpeg",
          },
          { quoted: m },
        );
        break;

      case "weather":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide an ringtone Search Term !\n\n*${prefix}weather Kolkata*`,
          );
        }
        await doReact("🌤");
        const myweather = await axios.get(
          `https://api.openweathermap.org/data/2.5/weather?q=${text}&units=metric&appid=e409825a497a0c894d2dd975542234b0&language=tr`,
        );

        let weathertext = `           🌤 *Weather Report* 🌤  \n\n🔎 *Search Location:* ${myweather.data.name}\n*💮 Country:* ${myweather.data.sys.country}\n🌈 *Weather:* ${myweather.data.weather[0].description}\n🌡️ *Temperature:* ${myweather.data.main.temp}°C\n❄️ *Minimum Temperature:* ${myweather.data.main.temp_min}°C\n📛 *Maximum Temperature:* ${myweather.data.main.temp_max}°C\n💦 *Humidity:* ${myweather.data.main.humidity}%\n🎐 *Wind:* ${myweather.data.wind.speed} km/h\n`;

        await Hooper.sendMessage(
          m.from,
          {
            video: {
              url: "https://media.tenor.com/bC57J4v11UcAAAPo/weather-sunny.mp4",
            },
            gifPlayback: true,
            caption: weathertext,
          },
          { quoted: m },
        );
        break;



      case "gh":
      case "github":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide a valid *Github* username!\n\nExample: *${prefix}gh FantoX001*`,
          );
        }
        await doReact("📊");
        let GHuserInfo;
        try {
          const ghRes = await axios.get(`https://api.github.com/users/${text}`);
          GHuserInfo = ghRes.data;
        } catch (error) {
          await doReact("❌");
          return m.reply(
            `GitHub user not found or API error: ${error.message}`,
          );
        }
        const GhUserPP = GHuserInfo.avatar_url;
        let resText4 = `        *🏮 GitHub User Info 🏮*\n\n_🎀 Username:_ *${GHuserInfo.login}*\n_🧩 Name:_ *${GHuserInfo.name}*\n\n_🧣 Bio:_ *${GHuserInfo.bio}*\n\n_🍁 Total Followers:_ *${GHuserInfo.followers}*\n_🔖 Total Public Repos:_ *${GHuserInfo.public_repos}*\n_📌 Website:_ ${GHuserInfo.blog}\n`;

        Hooper.sendMessage(
          m.from,
          {
            image: { url: GhUserPP, mimetype: "image/jpeg" },
            caption: resText4,
          },
          { quoted: m },
        );
        break;

      case "wikipedia":
      case "wiki":
        if (!text) {
          await doReact("❔");
          return m.reply(`Please provide a search term!\n\nExample: *${prefix}wiki Elon Musk*`);
        }
        await doReact("📖");
        try {
          // Search for the best matching article
          const searchRes = await axios.get(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`,
            {
              timeout: 10000,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
            }
          );
          const { title, extract, thumbnail, content_urls } = searchRes.data;
          if (!extract) {
            await doReact("❌");
            return m.reply(`No Wikipedia article found for: *${text}*`);
          }
          // Trim extract to 800 chars
          const summary = extract.length > 800 ? extract.slice(0, 800) + "..." : extract;
          const caption = `📖 *${title}*\n\n${summary}\n\n🔗 ${content_urls?.desktop?.page || ""}`;
          if (thumbnail?.source) {
            await Hooper.sendMessage(m.from, { image: { url: thumbnail.source }, caption }, { quoted: m });
          } else {
            await Hooper.sendMessage(m.from, { text: caption }, { quoted: m });
          }
        } catch (err) {
          if (err.response?.status === 404) {
            await doReact("❌");
            return m.reply(`No Wikipedia article found for: *${text}*`);
          }
          console.error("[ WIKI ] Error:", err.message);
          await doReact("❌");
          m.reply(`Wikipedia search failed: ${err.message}`);
        }
        break;

      default:
        break;
    }
  },
};
