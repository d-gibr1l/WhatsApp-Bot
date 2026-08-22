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
            `https://api.tenor.com/v1/search?q=${text}&key=LIVDSRZULELA&limit=12&media_filter=mp4`,
          );
          let resultGif = Math.floor(Math.random() * 12);
          let gifUrl = resGif.data.results[resultGif].media[0].mp4.url;
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
      case "pinterest":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide an Pinterest image Search Term !\n\nExample: *${prefix}pin cheems*`,
          );
        }
        await doReact("📍");
        try {
          const { data: pinHtml } = await axios.get(
            `https://www.bing.com/images/search?q=site:pinterest.com+${encodeURIComponent(text)}&first=1&count=20`,
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
            return m.reply(`No Pinterest images found for: *${text}*`);
          }
          const pool = pinUrls.slice(0, 10);
          const imgnyee = pool[Math.floor(Math.random() * pool.length)];

          await Hooper.sendMessage(
            m.from,
            {
              image: { url: imgnyee },
              caption: `\n_📍 Pinterest Search:_ *${text}*\n\n_🧩 Powered by_ *${botName}*\n`,
            },
            { quoted: m },
          );
        } catch (e) {
          console.error("Pin Error:", e.message);
          await doReact("❌");
          return m.reply(`An error occurred: ${e.message}`);
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

        try {
          const { createCanvas, loadImage } = await import("@napi-rs/canvas");

          const width = 800;
          const height = 400;
          const canvas = createCanvas(width, height);
          const ctx = canvas.getContext("2d");

          // Background - Dark Mode Twitter (#15202B)
          ctx.fillStyle = "#15202B";
          ctx.fillRect(0, 0, width, height);

          // Inner Card Container (#192734)
          ctx.fillStyle = "#192734";
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(20, 20, width - 40, height - 40, 16);
            ctx.fill();
          } else {
            ctx.fillRect(20, 20, width - 40, height - 40);
          }

          // Avatar Image
          let avatarImg;
          try {
            avatarImg = await loadImage(avatarUrl);
          } catch {}

          if (avatarImg) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(80, 80, 35, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatarImg, 45, 45, 70, 70);
            ctx.restore();
          } else {
            ctx.fillStyle = "#1DA1F2";
            ctx.beginPath();
            ctx.arc(80, 80, 35, 0, Math.PI * 2, true);
            ctx.fill();
          }

          // Display Name
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "bold 24px sans-serif";
          ctx.fillText(pushName2.slice(0, 25), 135, 72);

          // Username
          ctx.fillStyle = "#8899A6";
          ctx.font = "20px sans-serif";
          ctx.fillText(`@${username.slice(0, 20)}`, 135, 100);

          // Tweet Text Formatting & Word Wrap
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "22px sans-serif";
          
          const words = tweetText.split(" ");
          let line = "";
          let y = 160;
          const maxWidth = width - 100;
          const lineHeight = 32;

          for (let n = 0; n < words.length; n++) {
            const testLine = line + words[n] + " ";
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && n > 0) {
              ctx.fillText(line, 50, y);
              line = words[n] + " ";
              y += lineHeight;
              if (y > height - 80) break; // Don't overflow canvas
            } else {
              line = testLine;
            }
          }
          ctx.fillText(line, 50, y);

          // Twitter Footer
          ctx.fillStyle = "#1DA1F2";
          ctx.font = "bold 18px sans-serif";
          ctx.fillText("🐦 Twitter for WhatsApp", 50, height - 40);

          const buffer = canvas.toBuffer("image/png");

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
