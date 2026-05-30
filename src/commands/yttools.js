import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { getYtDlpPath, getCookiesPath, searchGifs, downloadImageUrl } from "../downloader.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTimestamp(str) {
  if (!str) return 0;
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0];
}

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

async function getYtDlpInfo(url) {
  const cookiePath = await getCookiesPath();
  const cookiesFlag = cookiePath ? `--cookies "${cookiePath}"` : "";
  const ytDlpPath = getYtDlpPath();

  try {
    const json = execSync(
      `"${ytDlpPath}" --dump-json --no-playlist ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" "${url}"`,
      { timeout: 30000, encoding: "utf8" }
    );
    return JSON.parse(json);
  } finally {
    if (cookiePath && existsSync(cookiePath)) {
      try { unlinkSync(cookiePath); } catch {}
    }
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const ytToolsCommands = {

  // ── !info ───────────────────────────────────────────────────────────────────
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
        const info = await getYtDlpInfo(url);

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

  // ── !sub ────────────────────────────────────────────────────────────────────
  sub: {
    adminOnly: false,
    requiresArgs: true,
    description: "Extract subtitles/captions from a YouTube video",
    usage: "!sub <url> [language]",
    examples: [
      "!sub https://youtu.be/xxxx",
      "!sub https://youtu.be/xxxx en",
      "!sub https://youtu.be/xxxx es",
    ],
    notes: "Defaults to English (en). Uses auto-generated captions if manual subs unavailable.",
    handler: async (sock, msg, args, from, prefix) => {
      const url  = args[0];
      const lang = args[1] || "en";

      if (!url?.startsWith("http")) return replyMsg(sock, from, msg,
        `📖 *${prefix}sub <url> [language]*\n\nExtract captions from a YouTube video.\n\n💡 Examples:\n• ${prefix}sub https://youtu.be/xxxx\n• ${prefix}sub https://youtu.be/xxxx es`
      );

      await reactMsg(sock, from, msg, "📝");

      const tmpDir  = join(tmpdir(), `sub_${Date.now()}`);
      const tmpBase = join(tmpDir, "sub");
      const cookiePath = await getCookiesPath();
      const cookiesFlag = cookiePath ? `--cookies "${cookiePath}"` : "";
      const ytDlpPath = getYtDlpPath();

      try {
        // Create temp dir
        execSync(`mkdir -p "${tmpDir}"`);

        // Try manual subs first, fall back to auto-generated
        let subFile = null;
        try {
          execSync(
            `"${ytDlpPath}" --write-subs --sub-lang ${lang} --skip-download --convert-subs srt ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" -o "${tmpBase}" "${url}"`,
            { timeout: 30000 }
          );
          subFile = `${tmpBase}.${lang}.srt`;
          if (!existsSync(subFile)) subFile = null;
        } catch {}

        if (!subFile) {
          execSync(
            `"${ytDlpPath}" --write-auto-subs --sub-lang ${lang} --skip-download --convert-subs srt ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" -o "${tmpBase}" "${url}"`,
            { timeout: 30000 }
          );
          subFile = `${tmpBase}.${lang}.srt`;
        }

        if (!existsSync(subFile)) {
          throw new Error(`No subtitles found for language "${lang}". Try a different language code.`);
        }

        // Parse SRT — strip timestamps, deduplicate lines
        const raw = readFileSync(subFile, "utf8");
        const lines = raw.split("\n");
        const textLines = [];
        let prev = "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || /^\d+$/.test(trimmed) || trimmed.includes("-->")) continue;
          // Remove HTML tags like <i>, <b>, <font>
          const clean = trimmed.replace(/<[^>]+>/g, "").trim();
          if (clean && clean !== prev) {
            textLines.push(clean);
            prev = clean;
          }
        }

        if (textLines.length === 0) throw new Error("Subtitles found but appear to be empty.");

        // Get title for header
        let title = url;
        try { title = (await getYtDlpInfo(url)).title; } catch {}

        const subtitleText = textLines.join("\n");
        const header = `📝 *Subtitles: ${title}*\n🌐 Language: ${lang}\n\n`;

        // WhatsApp message limit ~65K chars — split if needed
        const MAX = 4000;
        if (subtitleText.length <= MAX) {
          await reactMsg(sock, from, msg, "✅");
          await replyMsg(sock, from, msg, header + subtitleText);
        } else {
          await reactMsg(sock, from, msg, "✅");
          await replyMsg(sock, from, msg, header + subtitleText.slice(0, MAX) + "\n\n_...truncated (too long)_");
        }

      } catch (err) {
        console.error("❌ sub error:", err.message);
        if (err.message.includes("No subtitles")) {
          await reactMsg(sock, from, msg, "❌");
          await replyMsg(sock, from, msg, `❌ ${err.message}`);
        } else {
          await failMsg(sock, from, msg, err, "sub");
        }
      } finally {
        try { execSync(`rm -rf "${tmpDir}"`); } catch {}
        if (cookiePath && existsSync(cookiePath)) {
          try { unlinkSync(cookiePath); } catch {}
        }
      }
    },
  },

  // ── !gif ────────────────────────────────────────────────────────────────────
  gif: {
    adminOnly: false,
    requiresArgs: true,
    description: "Search for GIFs or create a GIF from a video URL",
    usage: "!gif <query> OR !gif <url> [start] [duration]",
    examples: [
      "!gif michael jackson 3",
      "!gif https://youtu.be/xxxx 0:30 5",
    ],
    notes: "If you provide words, it searches Tenor. If you provide a URL, it makes a GIF from the video.",
    handler: async (sock, msg, args, from, prefix) => {
      const urlOrQuery = args[0];
      if (!urlOrQuery) return replyMsg(sock, from, msg,
        `📖 *${prefix}gif <url> [start] [duration]*\n` +
        `Create a GIF from a video.\n\n` +
        `📖 *${prefix}gif <search term> [count]*\n` +
        `Search and download GIFs.\n\n` +
        `💡 *Examples:*\n` +
        `• ${prefix}gif https://youtu.be/xxxx 0:30 8\n` +
        `• ${prefix}gif michael jackson 3`
      );

      if (urlOrQuery.startsWith("http")) {
        // --- YOUTUBE GIF CREATOR ---
        const url = args[0];
        const startSec   = args[1] ? parseTimestamp(args[1]) : 0;
        const durationSec = args[2] ? Math.min(parseInt(args[2]), 15) : 6;

        await reactMsg(sock, from, msg, "⏳");

        const tmpVid = join(tmpdir(), `gif_vid_${Date.now()}.mp4`);
        const tmpGif = join(tmpdir(), `gif_out_${Date.now()}.mp4`);
        const cookiePath = await getCookiesPath();
        const cookiesFlag = cookiePath ? `--cookies "${cookiePath}"` : "";
        const ytDlpPath = getYtDlpPath();

        try {
          execSync(
            `"${ytDlpPath}" -f "bestvideo[height<=480][ext=mp4]+bestaudio/best[height<=480]" --merge-output-format mp4 ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" -o "${tmpVid}" "${url}"`,
            { timeout: 120000 }
          );

          if (!existsSync(tmpVid)) throw new Error("yt-dlp produced no file.");

          execSync(
            `ffmpeg -ss ${startSec} -i "${tmpVid}" -t ${durationSec} -vf "fps=15,scale=320:-2:flags=lanczos" -an -movflags +faststart -loop 0 "${tmpGif}" -y`,
            { timeout: 60000 }
          );

          if (!existsSync(tmpGif)) throw new Error("ffmpeg produced no output.");

          const buffer = readFileSync(tmpGif);
          const mb = buffer.length / (1024 * 1024);

          if (mb > 64) {
            return replyMsg(sock, from, msg,
              `❌ GIF too large (${mb.toFixed(1)}MB).\n\n💡 Try a shorter duration:\n• ${prefix}gif ${url} ${args[1] || "0:00"} 4`
            );
          }

          await reactMsg(sock, from, msg, "✅");
          await sock.sendMessage(from, {
            video: buffer,
            mimetype: "video/mp4",
            gifPlayback: true,
            caption: "",
          }, { quoted: msg });

        } catch (err) {
          console.error("❌ gif error:", err.message);
          await failMsg(sock, from, msg, err, "gif");
        } finally {
          try { unlinkSync(tmpVid); } catch {}
          try { unlinkSync(tmpGif); } catch {}
          if (cookiePath && existsSync(cookiePath)) {
            try { unlinkSync(cookiePath); } catch {}
          }
        }
      } else {
        // --- TENOR GIF SEARCH ---
        let queryParts = [...args];
        let count = 3;

        const lastArg = queryParts[queryParts.length - 1];
        if (/^\d+$/.test(lastArg)) {
          count = Math.min(Math.max(parseInt(lastArg, 10), 1), 10);
          queryParts.pop();
        }

        const query = queryParts.join(" ").trim();
        await reactMsg(sock, from, msg, "🔍");

        let gifUrls;
        try {
          gifUrls = await searchGifs(query, count + 2);
        } catch (err) {
          console.error(`GIF search failed for "${query}":`, err.message);
          return replyMsg(sock, from, msg, `❌ GIF search failed. Please try again later.`);
        }

        if (!gifUrls || !gifUrls.length) {
          return replyMsg(sock, from, msg, `❌ No GIFs found for *${query}*.`);
        }

        const toDownload = gifUrls.slice(0, count);
        let sent = 0;
        let failed = 0;

        for (const url of toDownload) {
          try {
            const { buffer } = await downloadImageUrl(url);
            if (!buffer) throw new Error("Empty buffer");

            await sock.sendMessage(from, {
              video: buffer,
              mimetype: "video/mp4",
              gifPlayback: true,
            }, { quoted: msg });

            sent++;
            await new Promise(r => setTimeout(r, 800));
          } catch (err) {
            console.error(`GIF download failed [${url.slice(0, 60)}]:`, err.message);
            failed++;
          }
        }

        if (sent === 0) {
          await replyMsg(sock, from, msg, `❌ Couldn't download any GIFs for *${query}*.\n\nTry a different search term.`);
        } else {
          await reactMsg(sock, from, msg, "✅");
          if (failed > 0) {
            await replyMsg(sock, from, msg, `⚠️ Only found ${sent} downloadable GIF${sent !== 1 ? "s" : ""} for *${query}* (${failed} failed).`);
          }
        }
      }
    },
  },

};
