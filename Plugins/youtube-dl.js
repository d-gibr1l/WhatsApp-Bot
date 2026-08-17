import axios from "axios";
import { downloadWithYtDlp, getMediaInfo } from "../src/downloader.js";
import fs from "fs";

let mergedCommands = [
  "play",
  "song",
  "yt",
  "ytmp3",
  "mp3",
  "ytmp4",
  "video",
  "mp4",
];

const YT_REGEX =
  /^(https?:\/\/)?((www|m|music)\.)?(youtube(-nocookie)?\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]+(\S+)?$/i;

const extractUrl = (text) => {
  if (!text) return null;
  const match = text.match(YT_REGEX);
  return match ? match[0] : null;
};

export default {
  name: "youtube",
  alias: [...mergedCommands],
  uniquecommands: ["play", "mp3", "mp4"],
  description: "Advanced YouTube system (Local Proxy/R2 based)",

  start: async (Hooper, m, { inputCMD, text, doReact, prefix }) => {
    const botName = global.botName || "HOOPER";
    let query = text?.trim();

    if (!query && m.quoted?.text) {
      query = m.quoted.text.trim();
    }

    if (!query) {
      return m.reply(`🎬 *YouTube Downloader*

📌 *Usage:*
• ${prefix}play <song name>
• ${prefix}mp3 <youtube link>
• ${prefix}mp4 <youtube link>

✨ Reply to link also works`);
    }

    try {
      let targetUrl = extractUrl(query) || `ytsearch1:${query}`;

      switch (inputCMD) {
        case "mp4":
        case "ytmp4":
        case "video": {
          await doReact("🎥");
          
          let info = await getMediaInfo(targetUrl);
          await Hooper.sendMessage(
            m.from,
            {
              image: info.thumbnail ? { url: info.thumbnail } : undefined,
              caption: `🎬 *${info.title}*\n⏱ ${info.duration || "Unknown"}\n\n⬇️ Downloading Video...`,
            },
            { quoted: m },
          );

          const { filePath, url, contentType, title } = await downloadWithYtDlp(targetUrl, false, "720");

          if (url) {
            // R2 Uploaded
            await Hooper.sendMessage(
              m.from,
              {
                video: { url },
                mimetype: contentType,
                caption: `🎬 *${title}*\n\n> Powered by ${botName} (Cloud Stream)`,
              },
              { quoted: m },
            );
          } else {
            // Local file
            await Hooper.sendMessage(
              m.from,
              {
                video: fs.readFileSync(filePath),
                mimetype: contentType,
                caption: `🎬 *${title}*\n\n> Powered by ${botName} (Local)`,
              },
              { quoted: m },
            );
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
          await doReact("✅");
          break;
        }

        case "play":
        case "song":
        case "yt":
        case "mp3":
        case "ytmp3": {
          await doReact("🎶");
          
          let info = await getMediaInfo(targetUrl);
          await Hooper.sendMessage(
            m.from,
            {
              image: info.thumbnail ? { url: info.thumbnail } : undefined,
              caption: `🎶 *${info.title}*\n\n⬇️ Downloading Audio...`,
            },
            { quoted: m },
          );

          const { filePath, url, contentType, title } = await downloadWithYtDlp(targetUrl, true);

          const audioPayload = url ? { url } : fs.readFileSync(filePath);

          await Hooper.sendMessage(
            m.from,
            {
              audio: audioPayload,
              mimetype: "audio/mpeg",
              contextInfo: {
                externalAdReply: {
                  title: title,
                  body: "🎧 YouTube Audio",
                  thumbnailUrl: info.thumbnail,
                  mediaType: 2,
                  renderLargerThumbnail: true,
                },
              },
            },
            { quoted: m },
          );

          if (!url && fs.existsSync(filePath)) fs.unlinkSync(filePath);
          await doReact("✅");
          break;
        }
      }
    } catch (err) {
      console.error("[ EXCEPTION ] YouTube Download Error:", err);
      m.reply(`❌ Error: ${err.message}`);
    }
  },
};
