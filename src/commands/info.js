import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { getMediaInfo } from "../downloader.js";

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}

function formatNumber(n) {
  if (!n) return "N/A";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export const infoCommands = {
  info: {
    adminOnly: false,
    requiresArgs: true,
    description: "Get info about any video — title, duration, views, uploader",
    usage: "!info <url>",
    examples: [
      "!info https://youtu.be/xxxx",
      "!info https://www.tiktok.com/@user/video/123",
      "!info https://www.instagram.com/p/xxx",
    ],
    notes: "Works on YouTube, TikTok, Instagram, Twitter/X and 1000+ sites.",
    handler: async (sock, msg, args, from, prefix) => {
      const url = args[0];
      if (!url?.startsWith("http")) return replyMsg(sock, from, msg,
        `📖 *${prefix}info <url>*\n\nGet details about any video.\n\n💡 Example:\n• ${prefix}info https://youtu.be/xxxx`
      );

      await reactMsg(sock, from, msg, "🔍");

      try {
        const info = await getMediaInfo(url);

        const duration  = info.duration ? formatDuration(Math.floor(info.duration)) : "N/A";
        const views     = formatNumber(info.view_count);
        const likes     = formatNumber(info.like_count);
        const uploader  = info.uploader || info.channel || "Unknown";
        const uploadDate = info.upload_date
          ? `${info.upload_date.slice(0,4)}-${info.upload_date.slice(4,6)}-${info.upload_date.slice(6,8)}`
          : "N/A";
        const platform  = info.extractor_key || "Unknown";

        const text =
          `🎬 *${info.title}*\n\n` +
          `📺 *Platform:* ${platform}\n` +
          `👤 *Uploader:* ${uploader}\n` +
          `⏱️ *Duration:* ${duration}\n` +
          `👀 *Views:* ${views}\n` +
          `❤️ *Likes:* ${likes}\n` +
          `📅 *Uploaded:* ${uploadDate}\n` +
          (info.description ? `\n📝 *Description:*\n${info.description.slice(0, 200)}${info.description.length > 200 ? "..." : ""}` : "");

        // Try to send thumbnail with info
        if (info.thumbnail) {
          try {
            const res = await fetch(info.thumbnail, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (res.ok) {
              const imgBuf = Buffer.from(await res.arrayBuffer());
              await reactMsg(sock, from, msg, "✅");
              await sock.sendMessage(from, {
                image: imgBuf,
                caption: text,
              }, { quoted: msg });
              return;
            }
          } catch {}
        }

        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, text);

      } catch (err) {
        console.error("❌ info error:", err.message);
        await failMsg(sock, from, msg, err, "info");
      }
    },
  },
};
