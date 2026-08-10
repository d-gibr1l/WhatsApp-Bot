import { exec, execFile } from "child_process";
import { promisify } from "util";
import { promises as fsPromises, existsSync } from "fs";

const execPromise = promisify(exec);
const execFilePromise = promisify(execFile);
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { getYtDlpPath, getCookiesPath } from "../downloader.js";

// Extract audio from a URL using yt-dlp
async function extractFromUrl(url, outPath) {
  const cookiePath = await getCookiesPath();
  const cookiesFlag = cookiePath ? `--cookies "${cookiePath}"` : "";
  const ytDlpPath = getYtDlpPath();

  // Get title if possible
  let title = "audio";
  try {
    const { stdout } = await execPromise(
      `"${ytDlpPath}" --dump-json --no-playlist ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" "${url}"`,
      { timeout: 30000, encoding: "utf8" }
    );
    title = JSON.parse(stdout).title ?? "audio";
  } catch {}

  try {
    await execPromise(
      `"${ytDlpPath}" -x --audio-format mp3 --audio-quality 0 ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" -o "${outPath}" "${url}"`,
      { timeout: 120000 }
    );
  } finally {
    if (cookiePath && existsSync(cookiePath)) {
      await fsPromises.unlink(cookiePath).catch(()=>{});
    }
  }

  return title;
}

// Extract audio from a raw video buffer using ffmpeg
async function extractFromBuffer(videoBuffer, outPath) {
  const inPath = join(tmpdir(), `vid_${Date.now()}.mp4`);
  await fsPromises.writeFile(inPath, videoBuffer);

  try {
    await execFilePromise("ffmpeg", [
      "-y", "-i", inPath,
      "-vn",                    // no video
      "-acodec", "libmp3lame",
      "-q:a", "2",              // high quality VBR
      outPath
    ], { timeout: 60000 });
  } catch (err) {
    throw new Error(err.stderr?.toString()?.slice(0, 200) ?? "ffmpeg failed");
  } finally {
    await fsPromises.unlink(inPath).catch(()=>{});
  }
}

export const mp3Commands = {

  mp3: {
    adminOnly: false,
    requiresArgs: false,
    description: "Extract audio (MP3) from a URL or a quoted/sent video",
    usage: "!mp3 <url>  OR  reply to a video with !mp3",
    examples: [
      "!mp3 https://youtube.com/watch?v=xxxx",
      "!mp3 https://youtu.be/xxxx",
      "!mp3 https://tiktok.com/...",
      "Reply to any video → !mp3",
    ],
    handler: async (sock, msg, args, from, prefix) => {
      const url         = args[0];
      const quotedMsg   = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const hasUrl      = url && url.startsWith("http");
      const hasVideo    = quotedMsg?.videoMessage || msg.message?.videoMessage;

      if (!hasUrl && !hasVideo) {
        return replyMsg(sock, from, msg,
          `📖 *How to use ${prefix}mp3*\n\n` +
          `🔧 *Method 1 — URL:*\n${prefix}mp3 <url>\n\n` +
          `🔧 *Method 2 — Video reply:*\nReply to any video with ${prefix}mp3\n\n` +
          `💡 *Supported:* YouTube, TikTok, Instagram, Twitter, Facebook, direct video links`
        );
      }

      await reactMsg(sock, from, msg, "🎵");

      const outPath = join(tmpdir(), `mp3_${Date.now()}.mp3`);

      try {
        let title = "audio";

        if (hasUrl) {
          // ── URL mode ──────────────────────────────────────────────────────
          title = await extractFromUrl(url, outPath);

        } else {
          // ── Quoted/sent video mode ────────────────────────────────────────
          const videoMsg = msg.message?.videoMessage
            ? msg
            : { message: quotedMsg, key: msg.message.extendedTextMessage.contextInfo };

          await reactMsg(sock, from, msg, "⬇️");
          const videoBuffer = await downloadMediaMessage(videoMsg, "buffer", {});
          await extractFromBuffer(videoBuffer, outPath);
          title = "video_audio";
        }

        if (!existsSync(outPath)) throw new Error("No output file produced.");

        const buffer = await fsPromises.readFile(outPath);
        await fsPromises.unlink(outPath).catch(()=>{});

        if (buffer.length > 64 * 1024 * 1024) {
          return replyMsg(sock, from, msg, "❌ File too large to send (max 64MB).");
        }

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          audio: buffer,
          mimetype: "audio/mpeg",
          fileName: `${title.slice(0, 50)}.mp3`,
        }, { quoted: msg });

      } catch (err) {
        await fsPromises.unlink(outPath).catch(()=>{});
        console.error("❌ mp3 error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Failed to extract audio: ${err.message.slice(0, 200)}`);
        await alertOwner(sock, `${prefix}mp3`, err);
      }
    },
  },

};
