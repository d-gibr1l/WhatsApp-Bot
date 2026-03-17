import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

const MAX_MB = 64;
function sizeMB(buf) { return buf.length / (1024 * 1024); }

function parseTimestamp(str) {
  if (!str) return 0;
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parseFloat(str) || 0;
}

async function getMediaBuffer(msg) {
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasVideo  = !!(msg.message?.videoMessage || quotedMsg?.videoMessage);
  const hasAudio  = !!(msg.message?.audioMessage || quotedMsg?.audioMessage);

  if (!hasVideo && !hasAudio) return null;

  const type = hasVideo ? "video" : "audio";
  const msgToDownload = (quotedMsg?.videoMessage || quotedMsg?.audioMessage)
    ? { key: msg.key, message: quotedMsg }
    : msg;

  const buffer = await downloadMediaMessage(msgToDownload, "buffer", {});
  return { buffer, type };
}

export const videoToolsCommands = {

  // ── !compress ───────────────────────────────────────────────────────────────
  compress: {
    adminOnly: false,
    requiresArgs: false,
    description: "Compress a video to reduce its file size",
    usage: "!compress [quality]",
    examples: [
      "Reply to a video → !compress",
      "Reply to a video → !compress low",
      "Reply to a video → !compress medium",
    ],
    notes: "Quality options: low (smallest), medium (default), high (best quality).",
    handler: async (sock, msg, args, from, prefix) => {
      const media = await getMediaBuffer(msg);
      if (!media || media.type !== "video") {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}compress [quality]*\n\nReply to a video with *${prefix}compress*\n\n` +
          `Quality options:\n• low — smallest file\n• medium — balanced (default)\n• high — best quality`
        );
      }

      const qualityMap = { low: "28", medium: "23", high: "18" };
      const q = qualityMap[args[0]?.toLowerCase()] || qualityMap.medium;

      await reactMsg(sock, from, msg, "⏳");

      const tmpIn  = join(tmpdir(), `comp_in_${Date.now()}.mp4`);
      const tmpOut = join(tmpdir(), `comp_out_${Date.now()}.mp4`);
      writeFileSync(tmpIn, media.buffer);

      try {
        execSync(
          `ffmpeg -i "${tmpIn}" -vcodec libx264 -crf ${q} -preset fast -acodec aac -b:a 128k "${tmpOut}" -y`,
          { timeout: 180000 }
        );

        if (!existsSync(tmpOut)) throw new Error("ffmpeg produced no output.");

        const outBuf = readFileSync(tmpOut);
        const origMB = sizeMB(media.buffer).toFixed(1);
        const newMB  = sizeMB(outBuf).toFixed(1);

        if (sizeMB(outBuf) > MAX_MB) {
          return replyMsg(sock, from, msg, `❌ Compressed file still too large (${newMB}MB). Try *${prefix}compress low*`);
        }

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          video: outBuf,
          mimetype: "video/mp4",
          caption: `📦 Compressed: ${origMB}MB → ${newMB}MB`,
        }, { quoted: msg });
      } finally {
        try { unlinkSync(tmpIn); } catch {}
        try { unlinkSync(tmpOut); } catch {}
      }
    },
  },

  // ── !reverse ────────────────────────────────────────────────────────────────
  reverse: {
    adminOnly: false,
    requiresArgs: false,
    description: "Reverse a video or audio clip",
    usage: "!reverse",
    examples: [
      "Reply to a video → !reverse",
      "Reply to an audio → !reverse",
    ],
    handler: async (sock, msg, _args, from, prefix) => {
      const media = await getMediaBuffer(msg);
      if (!media) {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}reverse*\n\nReply to a video or audio with *${prefix}reverse*`
        );
      }

      await reactMsg(sock, from, msg, "⏳");

      const ext    = media.type === "video" ? "mp4" : "mp3";
      const tmpIn  = join(tmpdir(), `rev_in_${Date.now()}.${ext}`);
      const tmpOut = join(tmpdir(), `rev_out_${Date.now()}.${ext}`);
      writeFileSync(tmpIn, media.buffer);

      try {
        if (media.type === "video") {
          execSync(
            `ffmpeg -i "${tmpIn}" -vf reverse -af areverse "${tmpOut}" -y`,
            { timeout: 120000 }
          );
        } else {
          execSync(
            `ffmpeg -i "${tmpIn}" -af areverse "${tmpOut}" -y`,
            { timeout: 60000 }
          );
        }

        if (!existsSync(tmpOut)) throw new Error("ffmpeg produced no output.");
        const outBuf = readFileSync(tmpOut);

        if (sizeMB(outBuf) > MAX_MB) {
          return replyMsg(sock, from, msg, `❌ Output too large (${sizeMB(outBuf).toFixed(1)}MB).`);
        }

        await reactMsg(sock, from, msg, "✅");

        if (media.type === "video") {
          await sock.sendMessage(from, { video: outBuf, mimetype: "video/mp4" }, { quoted: msg });
        } else {
          await sock.sendMessage(from, { audio: outBuf, mimetype: "audio/mpeg", ptt: false }, { quoted: msg });
        }
      } finally {
        try { unlinkSync(tmpIn); } catch {}
        try { unlinkSync(tmpOut); } catch {}
      }
    },
  },

};
