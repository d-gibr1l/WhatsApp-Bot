import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { getSetting } from "../db.js";

async function getCookiesFlag() {
  try {
    const cookies = await getSetting("yt_cookies", null);
    if (!cookies || cookies.trim() === "") return "";
    const cookiePath = join(tmpdir(), "yt_cookies.txt");
    writeFileSync(cookiePath, cookies);
    return `--cookies "${cookiePath}"`;
  } catch {
    return "";
  }
}

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

export const mp3Commands = {

  mp3: {
    adminOnly: false,
    requiresArgs: true,
    description: "Extract audio (MP3) from a YouTube video or any URL",
    usage: "!mp3 <url>",
    examples: [
      "!mp3 https://youtube.com/watch?v=xxxx",
      "!mp3 https://youtu.be/xxxx",
    ],
    handler: async (sock, msg, args, from, prefix) => {
      const url = args[0];
      if (!url || !url.startsWith("http")) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}mp3*\n\n🔧 *Syntax:*\n${prefix}mp3 <url>\n\n💡 *Example:*\n• ${prefix}mp3 https://youtu.be/xxxx`
      );

      await reactMsg(sock, from, msg, "🎵");

      const outPath = join(tmpdir(), `mp3_${Date.now()}.mp3`);

      try {
        if (isYouTubeUrl(url)) {
          const cookiesFlag = await getCookiesFlag();
          // Get title first
          let title = "Audio";
          try {
            const info = execSync(
              `yt-dlp --dump-json --no-playlist ${cookiesFlag} "${url}"`,
              { timeout: 30000, encoding: "utf8" }
            );
            title = JSON.parse(info).title ?? "Audio";
          } catch {}

          execSync(
            `yt-dlp -x --audio-format mp3 --audio-quality 0 ${cookiesFlag} -o "${outPath}" "${url}"`,
            { timeout: 120000 }
          );

          if (!existsSync(outPath)) throw new Error("yt-dlp did not produce output file.");

          const buffer = readFileSync(outPath);
          try { unlinkSync(outPath); } catch {}

          if (buffer.length > 64 * 1024 * 1024) {
            return replyMsg(sock, from, msg, "❌ File too large to send (max 64MB).");
          }

          await reactMsg(sock, from, msg, "✅");
          await sock.sendMessage(from, {
            audio: buffer,
            mimetype: "audio/mpeg",
            fileName: `${title.slice(0, 50)}.mp3`,
          }, { quoted: msg });

        } else {
          // Non-YouTube: try yt-dlp anyway (works for many sites)
          const cookiesFlag = await getCookiesFlag();
          execSync(
            `yt-dlp -x --audio-format mp3 --audio-quality 0 ${cookiesFlag} -o "${outPath}" "${url}"`,
            { timeout: 120000 }
          );

          if (!existsSync(outPath)) throw new Error("Could not extract audio from this URL.");

          const buffer = readFileSync(outPath);
          try { unlinkSync(outPath); } catch {}

          await reactMsg(sock, from, msg, "✅");
          await sock.sendMessage(from, {
            audio: buffer,
            mimetype: "audio/mpeg",
            fileName: `audio_${Date.now()}.mp3`,
          }, { quoted: msg });
        }

      } catch (err) {
        try { if (existsSync(outPath)) unlinkSync(outPath); } catch {}
        console.error("❌ mp3 error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Failed to extract audio: ${err.message.slice(0, 200)}`);
        await alertOwner(sock, `${prefix}mp3`, err);
      }
    },
  },

};
