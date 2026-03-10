import { getSetting, setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { getMediaInfo, downloadToBuffer, downloadYouTubeToBuffer, detectPlatform, extractUrl } from "../downloader.js";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

export const downloaderCommands = {

  dl: {
    adminOnly: false,
    requiresArgs: true,
    description: "Download media from YouTube, TikTok, Instagram, Twitter/X or Facebook",
    usage: "!dl <url> [audio]",
    examples: [
      "!dl https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "!dl https://youtu.be/dQw4w9WgXcQ audio",
      "!dl https://youtube.com/shorts/abc123",
      "!dl https://www.tiktok.com/@user/video/123456",
    ],
    notes: "Add 'audio' at the end to download audio only (YouTube only). Max file size is 64MB.",
    handler: async (sock, msg, args, from, prefix) => {
      const url = args[0] || extractUrl(
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || ""
      );
      if (!url) return replyMsg(sock, from, msg,
        `Usage: ${prefix}dl <url>\n\nSupported: YouTube, TikTok, Instagram, Twitter/X, Facebook\n\n💡 Tip: Add "audio" after YouTube links to get audio only.`
      );

      const platform = detectPlatform(url);
      if (!platform) return replyMsg(sock, from, msg,
        "❌ Unsupported link. Supported: YouTube, TikTok, Instagram, Twitter/X, Facebook"
      );

      const dlActive = cachedGetSetting("downloader_active", "true");
      if (dlActive !== "true") return replyMsg(sock, from, msg, "❌ The media downloader is currently disabled.");

      const audioOnly = args.includes("audio");

      await reactMsg(sock, from, msg, "⏳");

      try {
        const info = await getMediaInfo(url);

        // ── YouTube: use yt-dlp directly ──────────────────────────────────────
        if (info.useYtDlp) {
          await replyMsg(sock, from, msg,
            `📥 *${info.title}*\n${audioOnly ? "🎵 Audio only" : "🎬 Video 720p"}\n\nDownloading...`
          );

          const { buffer, contentType } = await downloadYouTubeToBuffer(url, audioOnly);
          const sizeMB = buffer.length / (1024 * 1024);

          if (sizeMB > 64) {
            return replyMsg(sock, from, msg,
              `❌ File too large (${sizeMB.toFixed(1)}MB). WhatsApp limit is 64MB.\n\n💡 Try a shorter video or use the audio option:\n${prefix}dl ${url} audio`
            );
          }

          if (audioOnly || contentType.includes("audio")) {
            await sock.sendMessage(from, {
              audio: buffer,
              mimetype: "audio/mp4",
              ptt: false,
            }, { quoted: msg });
          } else {
            await sock.sendMessage(from, {
              video: buffer,
              mimetype: "video/mp4",
              caption: `📥 ${info.title}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── Other platforms: use API + downloadToBuffer ───────────────────────
        if (!info.videoUrl && !info.audioUrl) {
          return replyMsg(sock, from, msg, `❌ No downloadable link found for this post.`);
        }

        const mediaUrl = info.videoUrl || info.audioUrl;
        const isAudio  = !info.videoUrl;

        await replyMsg(sock, from, msg,
          `📥 *${info.platform}*: ${info.title}\n🎬 Quality: ${info.quality}\n\nDownloading...`
        );

        const { buffer, contentType } = await downloadToBuffer(mediaUrl);
        const sizeMB = buffer.length / (1024 * 1024);

        if (sizeMB > 64) {
          return replyMsg(sock, from, msg,
            `❌ File too large (${sizeMB.toFixed(1)}MB). WhatsApp limit is 64MB.\n\n🔗 Direct link:\n${mediaUrl}`
          );
        }

        if (isAudio || contentType.includes("audio")) {
          await sock.sendMessage(from, {
            audio: buffer,
            mimetype: "audio/mp4",
            ptt: false,
          }, { quoted: msg });
        } else {
          await sock.sendMessage(from, {
            video: buffer,
            mimetype: "video/mp4",
            caption: `📥 ${info.title}`,
          }, { quoted: msg });
        }

      } catch (err) {
        console.error("❌ Download error:", err.message);
        await replyMsg(sock, from, msg, `❌ Download failed: ${err.message}`);
        await alertOwner(sock, `${prefix}dl — ${url}`, err);
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
