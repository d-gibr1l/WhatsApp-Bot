import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises, existsSync } from "fs";

const execPromise = promisify(exec);
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { getYtDlpPath, getCookiesPath, searchGifs, downloadImageUrl } from "../downloader.js";

function parseTimestamp(str) {
  if (!str) return 0;
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0];
}

export const gifCommands = {
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
          await execPromise(
            `"${ytDlpPath}" -f "bestvideo[height<=480][ext=mp4]+bestaudio/best[height<=480]" --merge-output-format mp4 ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" -o "${tmpVid}" "${url}"`,
            { timeout: 120000 }
          );

          if (!existsSync(tmpVid)) throw new Error("yt-dlp produced no file.");

          await execPromise(
            `ffmpeg -ss ${startSec} -i "${tmpVid}" -t ${durationSec} -vf "fps=15,scale=320:-2:flags=lanczos" -an -movflags +faststart -loop 0 "${tmpGif}" -y`,
            { timeout: 60000 }
          );

          if (!existsSync(tmpGif)) throw new Error("ffmpeg produced no output.");

          const buffer = await fsPromises.readFile(tmpGif);
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
          await fsPromises.unlink(tmpVid).catch(()=>{});
          await fsPromises.unlink(tmpGif).catch(()=>{});
          if (cookiePath && existsSync(cookiePath)) {
            await fsPromises.unlink(cookiePath).catch(()=>{});
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
