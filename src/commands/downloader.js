import { promises as fsPromises } from "fs";
import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { downloadWithYtDlp, downloadWithApi, extractUrl } from "../downloader.js";
import { replyMsg, reactMsg, alertOwner, failMsg } from "./helpers.js";

const MAX_MB = 64;



function getUrlFromMsg(msg, args) {
  if (args[0]?.startsWith("http")) return args[0];
  // Try quoted message
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quotedText =
    ctx?.quotedMessage?.conversation ||
    ctx?.quotedMessage?.extendedTextMessage?.text || "";
  return extractUrl(quotedText) || null;
}

export const downloaderCommands = {

  dl: {
    adminOnly: false,
    requiresArgs: false,
    description: "Download video/audio from YouTube, TikTok, Instagram, Twitter/X, Facebook, Reddit and more",
    usage: "!dl <url> [audio|360|720|1080]",
    examples: [
      "!dl https://youtu.be/xxxx",
      "!dl https://youtu.be/xxxx audio",
      "!dl https://youtu.be/xxxx 1080",
      "!dl https://www.tiktok.com/@user/video/123",
      "!dl https://www.instagram.com/p/xxx",
      "Reply to a message with a link → !dl",
    ],
    notes: "Powered by yt-dlp. Supports 1000+ sites. Max 64MB.",
    handler: async (sock, msg, args, from, prefix) => {
      const dlActive = cachedGetSetting("downloader_active", "true");
      if (dlActive !== "true") return replyMsg(sock, from, msg, "❌ The media downloader is currently disabled.");

      const url = getUrlFromMsg(msg, args);
      if (!url) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}dl*\n\n` +
        `🔧 *Syntax:* ${prefix}dl <url> [quality]\n\n` +
        `💡 *Examples:*\n` +
        `• ${prefix}dl https://youtu.be/xxxx\n` +
        `• ${prefix}dl https://youtu.be/xxxx audio\n` +
        `• ${prefix}dl https://youtu.be/xxxx 1080\n\n` +
        `📱 *Supported:* YouTube, TikTok, Instagram, Twitter/X, Facebook, Reddit, Vimeo, Pinterest & 1000+ more\n\n` +
        `💡 *Tip:* Reply to any message containing a link with ${prefix}dl`
      );

      const audioOnly = args.includes("audio");
      const quality   = args.find(a => ["360", "480", "720", "1080", "best"].includes(a)) || "720";

      await reactMsg(sock, from, msg, "⌛");

      let downloadedFilePath = null;
      try {
        const { filePath, contentType, title } = await downloadWithYtDlp(url, audioOnly, quality);
        downloadedFilePath = filePath;
        const stats = await fsPromises.stat(filePath);
        const mb = stats.size / (1024 * 1024);

        if (mb > MAX_MB) {
          return replyMsg(sock, from, msg,
            `❌ File too large (${mb.toFixed(1)}MB). WhatsApp limit is 64MB.\n\n💡 Try:\n• ${prefix}dl ${url} audio\n• ${prefix}dl ${url} 360`
          );
        }

        await reactMsg(sock, from, msg, "✅");

        if (audioOnly || contentType.includes("audio")) {
          await sock.sendMessage(from, {
            audio: { url: filePath },
            mimetype: "audio/mpeg",
            fileName: `${title.slice(0, 50)}.mp3`,
            ptt: false,
          }, { quoted: msg });
        } else if (contentType.includes("image")) {
          await sock.sendMessage(from, {
            image: { url: filePath },
            mimetype: contentType,
            caption: title,
          }, { quoted: msg });
        } else {
          await sock.sendMessage(from, {
            video: { url: filePath },
            mimetype: "video/mp4",
            caption: title,
          }, { quoted: msg });
        }

      } catch (err) {
        console.error("❌ Download error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg,
          `❌ Download failed: ${err.message.slice(0, 200)}\n\n💡 If this keeps failing try *${prefix}dlapi ${url}*`
        );
        await alertOwner(sock, `${prefix}dl — ${url}`, err);
      } finally {
        if (downloadedFilePath) {
          await fsPromises.unlink(downloadedFilePath).catch(() => {});
        }
      }
    },
  },

  // ── API-based download (fallback when yt-dlp fails for a platform) ─────────
  dlapi: {
    adminOnly: false,
    requiresArgs: false,
    description: "Download using RapidAPI (fallback for when !dl fails)",
    usage: "!dlapi <url>",
    examples: [
      "!dlapi https://www.tiktok.com/@user/video/123",
      "!dlapi https://www.instagram.com/p/xxx",
    ],
    notes: "Requires RapidAPI key set by admin. Use !dl first — only use this if !dl fails.",
    handler: async (sock, msg, args, from, prefix) => {
      const dlActive = cachedGetSetting("downloader_active", "true");
      if (dlActive !== "true") return replyMsg(sock, from, msg, "❌ The media downloader is currently disabled.");

      const url = getUrlFromMsg(msg, args);
      if (!url) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}dlapi*\n\n🔧 *Syntax:* ${prefix}dlapi <url>\n\n📌 Use this only if *${prefix}dl* fails.`
      );

      const apiKey = cachedGetSetting("rapidapi_key", null);
      if (!apiKey) return replyMsg(sock, from, msg,
        `❌ RapidAPI key not set.\n\n📌 Admin can set it with: *${prefix}setapikey <key>*`
      );

      await reactMsg(sock, from, msg, "⏳");

      let downloadedFilePath = null;
      try {
        const { filePath, title } = await downloadWithApi(url);
        downloadedFilePath = filePath;
        const stats = await fsPromises.stat(filePath);
        const mb = stats.size / (1024 * 1024);

        if (mb > MAX_MB) {
          return replyMsg(sock, from, msg, `❌ File too large (${mb.toFixed(1)}MB). WhatsApp limit is 64MB.`);
        }

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          video: { url: filePath },
          mimetype: "video/mp4",
          caption: title,
        }, { quoted: msg });

      } catch (err) {
        console.error("❌ dlapi error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await failMsg(sock, from, msg, err, "dlapi");
        await alertOwner(sock, `${prefix}dlapi — ${url}`, err);
      } finally {
        if (downloadedFilePath) {
          await fsPromises.unlink(downloadedFilePath).catch(() => {});
        }
      }
    },
  },

  dlon: {
    adminOnly: true,
    requiresArgs: false,
    description: "Enable the media downloader",
    handler: async (sock, msg, _args, from) => {
      await setSetting("downloader_active", "true");
      await refreshSettings();
      await replyMsg(sock, from, msg, "✅ Media downloader enabled.");
    },
  },

  dloff: {
    adminOnly: true,
    requiresArgs: false,
    description: "Disable the media downloader",
    handler: async (sock, msg, _args, from) => {
      await setSetting("downloader_active", "false");
      await refreshSettings();
      await replyMsg(sock, from, msg, "🔴 Media downloader disabled.");
    },
  },

};