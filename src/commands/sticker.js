import { execSync, spawnSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

// ─── Sticker metadata ─────────────────────────────────────────────────────────

function addStickerMetadata(webpBuffer, packName, authorName) {
  const tmpIn  = join(tmpdir(), `smeta_in_${Date.now()}.webp`);
  const tmpOut = join(tmpdir(), `smeta_out_${Date.now()}.webp`);
  try {
    const metadata = JSON.stringify({
      "sticker-pack-id": `bot-${Date.now()}`,
      "sticker-pack-name": packName,
      "sticker-pack-publisher": authorName,
    });
    writeFileSync(tmpIn, webpBuffer);
    execSync(`exiftool -UserComment='${metadata}' -o "${tmpOut}" "${tmpIn}" 2>/dev/null`, { timeout: 10000 });
    const result = readFileSync(tmpOut);
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
    return result;
  } catch {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
    return webpBuffer;
  }
}

// ─── Core converters ──────────────────────────────────────────────────────────

async function imageToSticker(inputBuffer, cropZoom = null) {
  const packName   = cachedGetSetting("sticker_pack_name", "Bot Stickers");
  const authorName = cachedGetSetting("sticker_pack_author", "WhatsApp Bot");

  let img = sharp(inputBuffer);

  if (cropZoom) {
    // cropZoom: "center" | "top" | "bottom" | "left" | "right" | number (zoom factor)
    const meta = await img.metadata();
    const size = Math.min(meta.width, meta.height);
    const zoom = typeof cropZoom === "number" ? cropZoom : 1;
    const cropSize = Math.round(size / zoom);
    const positions = {
      center: { left: Math.round((meta.width - cropSize) / 2), top: Math.round((meta.height - cropSize) / 2) },
      top:    { left: Math.round((meta.width - cropSize) / 2), top: 0 },
      bottom: { left: Math.round((meta.width - cropSize) / 2), top: meta.height - cropSize },
      left:   { left: 0, top: Math.round((meta.height - cropSize) / 2) },
      right:  { left: meta.width - cropSize, top: Math.round((meta.height - cropSize) / 2) },
    };
    const pos = (typeof cropZoom === "string" && positions[cropZoom]) ? positions[cropZoom] : positions.center;
    img = img.extract({ left: Math.max(0, pos.left), top: Math.max(0, pos.top), width: Math.min(cropSize, meta.width), height: Math.min(cropSize, meta.height) });
  }

  const webpBuffer = await img
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();

  return addStickerMetadata(webpBuffer, packName, authorName);
}

async function videoToSticker(inputBuffer, startSec = 0, durationSec = 6) {
  const packName   = cachedGetSetting("sticker_pack_name", "Bot Stickers");
  const authorName = cachedGetSetting("sticker_pack_author", "WhatsApp Bot");

  const tmpIn  = join(tmpdir(), `sv_in_${Date.now()}.mp4`);
  const tmpOut = join(tmpdir(), `sv_out_${Date.now()}.webp`);
  writeFileSync(tmpIn, inputBuffer);

  try {
    execSync(
      `ffmpeg -ss ${startSec} -i "${tmpIn}" -t ${durationSec} -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=15" -vcodec libwebp -lossless 0 -compression_level 6 -q:v 50 -loop 0 -preset picture -an -vsync 0 "${tmpOut}" -y`,
      { timeout: 60000 }
    );
    const webpBuffer = readFileSync(tmpOut);
    return addStickerMetadata(webpBuffer, packName, authorName);
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

async function urlToSticker(url, startSec = 0, durationSec = 6) {
  const tmpVid = join(tmpdir(), `su_vid_${Date.now()}.mp4`);
  const tmpOut = join(tmpdir(), `su_out_${Date.now()}.webp`);

  try {
    // Download clip with yt-dlp
    execSync(
      `yt-dlp -f "bestvideo[height<=480][ext=mp4]+bestaudio/best[height<=480]" --merge-output-format mp4 -o "${tmpVid}" "${url}"`,
      { timeout: 120000 }
    );

    if (!existsSync(tmpVid)) throw new Error("yt-dlp produced no file.");

    const buffer = readFileSync(tmpVid);
    return videoToSticker(buffer, startSec, durationSec);
  } finally {
    try { unlinkSync(tmpVid); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

function addTextToWebp(webpBuffer, text, position = "bottom") {
  const tmpIn  = join(tmpdir(), `st_in_${Date.now()}.webp`);
  const tmpOut = join(tmpdir(), `st_out_${Date.now()}.webp`);
  writeFileSync(tmpIn, webpBuffer);

  const yPos = position === "top" ? "h*0.05" : "h*0.80";
  try {
    execSync(
      `ffmpeg -i "${tmpIn}" -vf "drawtext=text='${text.replace(/'/g, "\\'")}':fontsize=40:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=${yPos}" "${tmpOut}" -y`,
      { timeout: 15000 }
    );
    const result = readFileSync(tmpOut);
    return result;
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

// ─── Parse timestamp helpers ──────────────────────────────────────────────────

function parseTimestamp(str) {
  // Accepts: 30, 1:30, 0:30
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseTimeRange(str) {
  // "0:10-0:20" or "10-20"
  const [start, end] = str.split("-").map(parseTimestamp);
  return { start, duration: end - start };
}

// ─── Get media from message ───────────────────────────────────────────────────

async function getMediaFromMsg(msg) {
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const directImg = msg.message?.imageMessage;
  const directVid = msg.message?.videoMessage;
  const directStk = msg.message?.stickerMessage;
  const quotedImg = quotedMsg?.imageMessage;
  const quotedVid = quotedMsg?.videoMessage;
  const quotedStk = quotedMsg?.stickerMessage;

  const type =
    directStk || quotedStk ? "sticker" :
    directVid || quotedVid ? "video" :
    directImg || quotedImg ? "image" : null;

  if (!type) return null;

  const msgToDownload = (quotedImg || quotedVid || quotedStk)
    ? { key: msg.key, message: quotedMsg }
    : msg;

  const buffer = await downloadMediaMessage(msgToDownload, "buffer", {});
  const seconds = (directVid || quotedVid)?.seconds ?? 0;
  return { buffer, type, seconds };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const stickerCommands = {

  sticker: {
    adminOnly: false,
    requiresArgs: false,
    description: "Convert image/video/URL to a WhatsApp sticker",
    usage: "!sticker [url] [timestamp or range]",
    examples: [
      "Send/reply to image → !sticker",
      "Send/reply to video → !sticker",
      "!sticker https://youtu.be/xxx",
      "!sticker https://youtu.be/xxx 0:30",
      "!sticker https://youtu.be/xxx 0:10-0:20",
      "!sticker https://tiktok.com/...",
    ],
    notes: "Videos use first 6s by default. Specify a time range for URL stickers.",
    handler: async (sock, msg, args, from, prefix) => {
      const url = args[0]?.startsWith("http") ? args[0] : null;

      // ── URL mode ────────────────────────────────────────────────────────────
      if (url) {
        let startSec = 0;
        let durationSec = 6;

        // Parse range like "0:10-0:20" or single timestamp "0:30"
        const timeArg = args[1];
        if (timeArg) {
          if (timeArg.includes("-")) {
            const range = parseTimeRange(timeArg);
            startSec    = range.start;
            durationSec = Math.min(range.duration, 10);
          } else {
            startSec    = parseTimestamp(timeArg);
            durationSec = 6;
          }
        }

        await reactMsg(sock, from, msg, "⏳");
        try {
          const webp = await urlToSticker(url, startSec, durationSec);
          await reactMsg(sock, from, msg, "✅");
          await sock.sendMessage(from, { sticker: webp }, { quoted: msg });
        } catch (err) {
          console.error("❌ URL sticker error:", err.message);
          await failMsg(sock, from, msg, err, "sticker url");
        }
        return;
      }

      // ── Media mode ──────────────────────────────────────────────────────────
      const media = await getMediaFromMsg(msg);

      if (!media) {
        return replyMsg(sock, from, msg,
          `📖 *How to use ${prefix}sticker*\n\n` +
          `*From media:*\n• Send/reply to an image or video with *${prefix}sticker*\n\n` +
          `*From URL:*\n• *${prefix}sticker* https://youtu.be/xxx\n• *${prefix}sticker* https://youtu.be/xxx 0:30\n• *${prefix}sticker* https://youtu.be/xxx 0:10-0:20\n\n` +
          `_Videos are capped at 10 seconds_`
        );
      }

      if (media.type === "video" && media.seconds > 10) {
        return replyMsg(sock, from, msg, "❌ Video must be 10 seconds or shorter for a sticker.");
      }

      await reactMsg(sock, from, msg, "⏳");
      try {
        const webp = media.type === "video"
          ? await videoToSticker(media.buffer, 0, Math.min(media.seconds || 6, 10))
          : await imageToSticker(media.buffer);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { sticker: webp }, { quoted: msg });
      } catch (err) {
        console.error("❌ Sticker error:", err.message);
        await failMsg(sock, from, msg, err, "sticker");
      }
    },
  },

  // ─── !toimage ───────────────────────────────────────────────────────────────
  toimage: {
    adminOnly: false,
    requiresArgs: false,
    description: "Convert a sticker back to an image",
    usage: "!toimage",
    examples: ["Reply to a sticker with !toimage"],
    handler: async (sock, msg, _args, from, prefix) => {
      const media = await getMediaFromMsg(msg);

      if (!media || media.type !== "sticker") {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}toimage*\n\nReply to a sticker with *${prefix}toimage* to convert it to an image.`
        );
      }

      await reactMsg(sock, from, msg, "⏳");
      try {
        const pngBuffer = await sharp(media.buffer).png().toBuffer();
        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { image: pngBuffer, mimetype: "image/png" }, { quoted: msg });
      } catch (err) {
        await failMsg(sock, from, msg, err, "toimage");
      }
    },
  },

  // ─── !stickertext ───────────────────────────────────────────────────────────
  stickertext: {
    adminOnly: false,
    requiresArgs: true,
    description: "Add text to a sticker or image",
    usage: "!stickertext <text> [top|bottom]",
    examples: [
      "Reply to sticker/image → !stickertext When you're late",
      "Reply to sticker/image → !stickertext Good morning top",
    ],
    notes: "Default position is bottom. Use 'top' for top text.",
    handler: async (sock, msg, args, from, prefix) => {
      const position = ["top", "bottom"].includes(args[args.length - 1]?.toLowerCase())
        ? args.pop().toLowerCase()
        : "bottom";
      const text = args.join(" ").trim();

      if (!text) return replyMsg(sock, from, msg,
        `📖 *${prefix}stickertext*\n\nReply to a sticker or image and add text:\n• *${prefix}stickertext When you're late*\n• *${prefix}stickertext Good morning top*`
      );

      const media = await getMediaFromMsg(msg);
      if (!media || !["sticker", "image"].includes(media.type)) {
        return replyMsg(sock, from, msg, `❌ Reply to a sticker or image with *${prefix}stickertext <text>*`);
      }

      await reactMsg(sock, from, msg, "⏳");
      try {
        // Convert to webp sticker with text overlay
        let inputBuffer = media.buffer;

        // If it's a sticker (webp), convert to png first for ffmpeg
        const tmpPng = join(tmpdir(), `stext_${Date.now()}.png`);
        const tmpOut = join(tmpdir(), `stext_out_${Date.now()}.webp`);
        const pngBuf = await sharp(inputBuffer).png().toBuffer();
        writeFileSync(tmpPng, pngBuf);

        const yPos = position === "top" ? "h*0.05" : "h*0.80";
        execSync(
          `ffmpeg -i "${tmpPng}" -vf "scale=512:512:force_original_aspect_ratio=decrease,drawtext=text='${text.replace(/'/g, "\\'")}':fontsize=40:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=${yPos}" -vcodec libwebp -q:v 80 "${tmpOut}" -y`,
          { timeout: 15000 }
        );

        const webpBuffer = readFileSync(tmpOut);
        const packName   = cachedGetSetting("sticker_pack_name", "Bot Stickers");
        const authorName = cachedGetSetting("sticker_pack_author", "WhatsApp Bot");
        const final = addStickerMetadata(webpBuffer, packName, authorName);

        try { unlinkSync(tmpPng); } catch {}
        try { unlinkSync(tmpOut); } catch {}

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { sticker: final }, { quoted: msg });
      } catch (err) {
        console.error("❌ stickertext error:", err.message);
        await failMsg(sock, from, msg, err, "stickertext");
      }
    },
  },

  // ─── !stickercrop ───────────────────────────────────────────────────────────
  stickercrop: {
    adminOnly: false,
    requiresArgs: false,
    description: "Crop and zoom an image before making it a sticker",
    usage: "!stickercrop [position] [zoom]",
    examples: [
      "Reply to image → !stickercrop",
      "Reply to image → !stickercrop center",
      "Reply to image → !stickercrop top",
      "Reply to image → !stickercrop center 2",
    ],
    notes: "Positions: center, top, bottom, left, right. Zoom: 1.5, 2, 3 etc.",
    handler: async (sock, msg, args, from, prefix) => {
      const positions = ["center", "top", "bottom", "left", "right"];
      const position  = positions.find(p => args.includes(p)) || "center";
      const zoomArg   = args.find(a => !isNaN(parseFloat(a)));
      const zoom      = zoomArg ? Math.min(Math.max(parseFloat(zoomArg), 1), 5) : 1;

      const media = await getMediaFromMsg(msg);
      if (!media || media.type !== "image") {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}stickercrop*\n\nReply to an image with *${prefix}stickercrop*\n\n` +
          `*Options:*\n• Position: center, top, bottom, left, right\n• Zoom: 1.5, 2, 3\n\n` +
          `*Examples:*\n• ${prefix}stickercrop top\n• ${prefix}stickercrop center 2`
        );
      }

      await reactMsg(sock, from, msg, "⏳");
      try {
        const cropParam = zoom > 1 ? zoom : position;
        const webp = await imageToSticker(media.buffer, cropParam);
        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { sticker: webp }, { quoted: msg });
      } catch (err) {
        await failMsg(sock, from, msg, err, "stickercrop");
      }
    },
  },

  setpackname: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set the sticker pack name shown in WhatsApp",
    usage: "!setpackname <name>",
    examples: ["!setpackname My Cool Stickers"],
    handler: async (sock, msg, args, from, prefix) => {
      const name = args.join(" ").trim();
      if (!name) return replyMsg(sock, from, msg,
        `📖 *${prefix}setpackname*\n\n🔧 Syntax: ${prefix}setpackname <name>`
      );
      try {
        await setSetting("sticker_pack_name", name);
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Sticker pack name set to: *${name}*`);
      } catch (err) {
        await failMsg(sock, from, msg, err, "setpackname");
      }
    },
  },

  setpackauthor: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set the sticker pack author name shown in WhatsApp",
    usage: "!setpackauthor <name>",
    examples: ["!setpackauthor Made by Gibril"],
    handler: async (sock, msg, args, from, prefix) => {
      const name = args.join(" ").trim();
      if (!name) return replyMsg(sock, from, msg,
        `📖 *${prefix}setpackauthor*\n\n🔧 Syntax: ${prefix}setpackauthor <name>`
      );
      try {
        await setSetting("sticker_pack_author", name);
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Sticker author name set to: *${name}*`);
      } catch (err) {
        await failMsg(sock, from, msg, err, "setpackauthor");
      }
    },
  },

};

// ─── Bulk Sticker Session Store ───────────────────────────────────────────────
// Map<chatJid, { sender, images: Buffer[], timer: TimeoutId }>

const stickerSessions = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 min auto-expire

export function hasStickerSession(chatJid) {
  return stickerSessions.has(chatJid);
}

export async function handleStickerSessionImage(sock, msg, from) {
  const session = stickerSessions.get(from);
  if (!session) return false;

  // In groups: participant holds sender JID
  // In DMs: remoteJid is the sender, participant is undefined
  // fromMe messages: treat as the session owner
  const sender = msg.key.fromMe
    ? session.sender  // always accept own images
    : (msg.key.participant ?? msg.key.remoteJid);

  // Only collect images from the user who started the session
  if (sender !== session.sender) return false;

  const imgMsg = msg.message?.imageMessage;
  if (!imgMsg) return false;

  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    session.images.push(buffer);
    await reactMsg(sock, from, msg, "📸");
    return true;
  } catch {
    return false;
  }
}

export const bulkStickerCommands = {

  stickers: {
    adminOnly: false,
    requiresArgs: false,
    description: "Start a bulk sticker session — send multiple images then type !done",
    usage: "!stickers",
    examples: [
      "!stickers → then send images → then !done",
    ],
    notes: "Session expires after 5 minutes of inactivity.",
    handler: async (sock, msg, _args, from, prefix) => {
      const sender = msg.key.participant ?? msg.key.remoteJid;

      if (stickerSessions.has(from)) {
        return replyMsg(sock, from, msg,
          `📸 Session already active!\n\nSend your images then type *${prefix}done* when finished.\nType *${prefix}cancel* to cancel.`
        );
      }

      // Start session
      const timer = setTimeout(() => {
        if (stickerSessions.has(from)) {
          stickerSessions.delete(from);
          sock.sendMessage(from, { text: "⏰ Sticker session expired — no images were collected." }).catch(() => {});
        }
      }, SESSION_TIMEOUT);

      stickerSessions.set(from, { sender, images: [], timer });

      await replyMsg(sock, from, msg,
        `📸 *Sticker session started!*\n\n` +
        `Send as many images as you want.\n` +
        `Type *${prefix}done* when finished to convert them all.\n` +
        `Type *${prefix}cancel* to cancel.\n\n` +
        `_Session expires in 5 minutes._`
      );
    },
  },

  done: {
    adminOnly: false,
    requiresArgs: false,
    description: "Finish a bulk sticker session and convert all collected images",
    usage: "!done",
    handler: async (sock, msg, _args, from, prefix) => {
      const session = stickerSessions.get(from);
      const sender  = msg.key.participant ?? msg.key.remoteJid;

      if (!session) {
        return replyMsg(sock, from, msg,
          `ℹ️ No active sticker session.\n\nStart one with *${prefix}stickers*`
        );
      }

      if (session.sender !== sender) {
        return replyMsg(sock, from, msg, "❌ Only the person who started the session can finish it.");
      }

      if (session.images.length === 0) {
        clearTimeout(session.timer);
        stickerSessions.delete(from);
        return replyMsg(sock, from, msg,
          `❌ No images were collected.\n\nStart again with *${prefix}stickers* and send images before typing *${prefix}done*`
        );
      }

      clearTimeout(session.timer);
      stickerSessions.delete(from);

      const total = session.images.length;
      await reactMsg(sock, from, msg, "⏳");
      await replyMsg(sock, from, msg, `⚙️ Converting ${total} image${total > 1 ? "s" : ""} to stickers...`);

      let success = 0;
      let failed  = 0;

      for (const imgBuffer of session.images) {
        try {
          const webp = await imageToSticker(imgBuffer);
          await sock.sendMessage(from, { sticker: webp }, { quoted: msg });
          success++;
        } catch {
          failed++;
        }
      }

      await reactMsg(sock, from, msg, "✅");
    },
  },

  cancel: {
    adminOnly: false,
    requiresArgs: false,
    description: "Cancel an active bulk sticker session",
    usage: "!cancel",
    handler: async (sock, msg, _args, from, prefix) => {
      const session = stickerSessions.get(from);
      const sender  = msg.key.participant ?? msg.key.remoteJid;

      if (!session) {
        return replyMsg(sock, from, msg, `ℹ️ No active sticker session to cancel.`);
      }

      if (session.sender !== sender) {
        return replyMsg(sock, from, msg, "❌ Only the person who started the session can cancel it.");
      }

      clearTimeout(session.timer);
      stickerSessions.delete(from);
      await replyMsg(sock, from, msg, `🗑️ Sticker session cancelled. ${session.images.length} image${session.images.length !== 1 ? "s" : ""} discarded.`);
    },
  },

};
