import axios from "axios";
let mergedCommands = [
  "gig",
  "gimage",
  "googleimage",
  "image",
  "ppcouple",
  "couplepp",
  "gifsearch",
  "gif",
  "pin",
  "pinterest",
  "tweet",
];

export default {
  name: "pictures",
  alias: [...mergedCommands],
  uniquecommands: ["image", "couplepp", "gif", "pin"],
  description: "All picture related commands",
  start: async (Hooper, m, { inputCMD, text, doReact, prefix, args }) => {
    switch (inputCMD) {
      case "ppcouple":
      case "couplepp":
        await doReact("❤️");
        try {
          const imgRes = await axios.get(
            "https://couple-pfp-api.vercel.app/api/v1/couplepfp",
            { timeout: 10000 }
          );
          await Hooper.sendMessage(
            m.from,
            { image: { url: imgRes.data.male }, caption: `_For Him..._` },
            { quoted: m },
          );
          await Hooper.sendMessage(
            m.from,
            { image: { url: imgRes.data.female }, caption: `_For Her..._` },
            { quoted: m },
          );
        } catch (e) {
          await doReact("❌");
          m.reply(`Couple PP fetch failed: ${e.message}`);
        }
        break;

      case "gig":
      case "gimage":
      case "googleimage":
      case "image":
        if (!text || !text.trim() || text === "undefined") {
          await doReact("❔");
          return m.reply(
            `Please provide an image Search Term !\n\nExample: *${prefix}image cheems*`,
          );
        }
        await doReact("🎴");
        try {
          const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(text)}&first=1&count=15&tsc=ImageBasicHover`;
          const { data: html } = await axios.get(bingUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
            timeout: 10000,
          });

          const imgUrls = [];
          for (const match of html.matchAll(
            /&quot;murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g,
          )) {
            imgUrls.push(match[1]);
          }

          if (!imgUrls.length) {
            await doReact("❌");
            return m.reply(`No images found for: *${text}*`);
          }

          const pool = imgUrls.slice(0, 10);
          const imageUrl = pool[Math.floor(Math.random() * pool.length)];
          const resText = `\n_🎴 Image Search:_ *${text}*\n\n_🧩 Powered by_ *${botName}*\n`;
          await Hooper.sendMessage(
            m.from,
            { image: { url: imageUrl }, caption: resText },
            { quoted: m },
          );
        } catch (err) {
          console.error("[ IMAGE ] Bing search error:", err.message);
          await doReact("❌");
          await m.reply(`Image search failed: ${err.message}`);
        }
        break;
      case "gif":
      case "gifsearch":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide an Tenor gif Search Term !\n\nExample: *${prefix}gif cheems bonk*`,
          );
        }
        await doReact("🎴");
        try {
          let resGif = await axios.get(
            `https://tenor.googleapis.com/v2/search?q=${text}&key=${tenorApiKey}&client_key=my_project&limit=12&media_filter=mp4`,
          );
          let resultGif = Math.floor(Math.random() * 12);
          let gifUrl = resGif.data.results[resultGif].media_formats.mp4.url;
          await Hooper.sendMessage(
            m.from,
            {
              video: { url: gifUrl },
              gifPlayback: true,
              caption: `🎀 Gif serach result for: *${text}*\n`,
            },
            { quoted: m },
          );
        } catch (e) {
          console.error("Gif Command Error:", e.message);
          m.reply("⚠️ GIF search failed. The API key might be expired or invalid.");
        }
        break;

      case "pin":
      case "pinterest": {
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide a search term.\n\n*Usage:*\n• \`${prefix}pin cheems\` — sends 1 image\n• \`${prefix}pin cheems 5\` — sends 5 images (max 10)`
          );
        }
        await doReact("📍");
        
        let queryParts = [...args];
        let count = 1;
        const lastArg = queryParts[queryParts.length - 1];
        if (/^\d+$/.test(lastArg)) {
          count = Math.min(Math.max(parseInt(lastArg, 10), 1), 10);
          queryParts.pop();
        }
        const query = queryParts.join(" ").trim();
        
        if (!query) {
          await doReact("❔");
          return m.reply(`Please provide a search term.\n\nExample: *${prefix}pin cheems 5*`);
        }
        
        try {
          const bingQuery = `site:pinterest.com ${query}`;
          const { data: pinHtml } = await axios.get(
            `https://www.bing.com/images/search?q=${encodeURIComponent(bingQuery)}&first=1&count=25`,
            {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
              },
              timeout: 10000,
            }
          );
          const pinUrls = [...pinHtml.matchAll(/&quot;murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g)]
            .map((m) => m[1])
            .filter((u) => u.includes("pinimg.com"));
            
          if (!pinUrls.length) {
            await doReact("❌");
            return m.reply(`No Pinterest images found for: *${query}*`);
          }
          
          // Randomize the pool slightly to get different results for same queries
          const shuffled = pinUrls.sort(() => 0.5 - Math.random());
          const selected = shuffled.slice(0, count);
          
          for (let i = 0; i < selected.length; i++) {
            const imgUrl = selected[i];
            const txt = i === 0 ? `\n_📍 Pinterest Search:_ *${query}*\n\n_🧩 Powered by_ *${botName}*\n` : "";
            await Hooper.sendMessage(m.from, { image: { url: imgUrl }, caption: txt }, { quoted: m });
            if (i < selected.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 600)); // Delay to prevent spam
            }
          }
        } catch (e) {
          await doReact("❌");
          m.reply(`Pinterest search failed: ${e.message}`);
        }
        break;
      case "tweet": {
        let tweetText = text;
        
        // If no text provided, check if replying to a text message
        if (!tweetText && m.quoted) {
          tweetText = m.quoted.conversation || m.quoted.extendedTextMessage?.text || m.quoted.imageMessage?.caption || m.quoted.videoMessage?.caption || "";
        }

        if (!tweetText) {
          await doReact("❔");
          return m.reply(`📖 *${prefix}tweet*\n\nPlease provide some text or reply to a message.\nExample: *${prefix}tweet Hello world!*`);
        }

        await doReact("⏳");

        const pushName2 = m.pushName || "WhatsApp User";
        const username = pushName2.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "user";
        
        let avatarUrl = "https://i.imgur.com/8Q5gQkk.png"; // Fallback default avatar
        try {
          const ppUrl = await Hooper.profilePictureUrl(m.sender, "image");
          if (ppUrl) avatarUrl = ppUrl;
        } catch (_err) {
          // Fallback
        }

        const apiUrl = `https://some-random-api.com/canvas/misc/tweet?avatar=${encodeURIComponent(avatarUrl)}&comment=${encodeURIComponent(tweetText)}&displayname=${encodeURIComponent(pushName2)}&username=${encodeURIComponent(username)}`;

        try {
          const response = await axios.get(apiUrl, { responseType: "arraybuffer" });
          const buffer = Buffer.from(response.data, "binary");

          await Hooper.sendMessage(m.from, {
            image: buffer,
            caption: "🐦 *Fake Tweet Generated!*"
          }, { quoted: m });
          
          await doReact("✅");
        } catch (err) {
          console.error("❌ Tweet generation error:", err.message);
          m.reply("⚠️ Failed to generate the tweet image. Please try again later.");
        }
        break;
      }

      default:
        break;
    }
  },
};
