import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// ─── Inject EXIF metadata into WebP for sticker pack name/author ──────────────

function addStickerMetadata(webpBuffer, packName, authorName) {
  try {
    // WhatsApp reads sticker metadata from the EXIF UserComment field
    // Format: JSON string with "sticker-pack-name" and "sticker-pack-publisher"
    const metadata = JSON.stringify({
      "sticker-pack-id": `bot-${Date.now()}`,
      "sticker-pack-name": packName,
      "sticker-pack-publisher": authorName,
      "android-app-store-link": "",
      "ios-app-store-link": "",
    });

    // Write buffer to temp file, inject EXIF, read back
    const tmpIn  = join(tmpdir(), `sticker_meta_in_${Date.now()}.webp`);
    const tmpOut = join(tmpdir(), `sticker_meta_out_${Date.now()}.webp`);
    writeFileSync(tmpIn, webpBuffer);

    // Use exiftool if available, otherwise return original buffer
    execSync(
      `exiftool -UserComment='${metadata}' -o "${tmpOut}" "${tmpIn}" 2>/dev/null`,
      { timeout: 10000 }
    );

    const result = readFileSync(tmpOut);
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
    return result;
  } catch {
    // exiftool not available — return original buffer without metadata
    return webpBuffer;
  }
}

export const stickerCommands = {

  sticker: {
    adminOnly: false,
    requiresArgs: false,
    description: "Convert an image or short video into a WhatsApp sticker",
    usage: "!sticker",
    examples: [
      "Send an image with caption: !sticker",
      "Send a video (≤10s) with caption: !sticker",
      "Reply to any image or video with: !sticker",
    ],
    notes: "Videos must be 10 seconds or shorter.",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");

        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const directImg = msg.message?.imageMessage;
        const directVid = msg.message?.videoMessage;
        const quotedImg = quotedMsg?.imageMessage;
        const quotedVid = quotedMsg?.videoMessage;

        const isVideo = !!(directVid || quotedVid);
        const isImage = !!(directImg || quotedImg);

        if (!isImage && !isVideo) {
          return replyMsg(sock, from, msg,
            `❌ No media found.\n\n` +
            `📖 *How to use ${prefix}sticker*\n\n` +
            `• Send an image with caption *${prefix}sticker*\n` +
            `• Send a short video (≤10s) with caption *${prefix}sticker*\n` +
            `• Reply to any image or video with *${prefix}sticker*`
          );
        }

        if (isVideo) {
          const vidMsg = directVid || quotedVid;
          if (vidMsg?.seconds > 10) {
            return replyMsg(sock, from, msg, "❌ Video must be 10 seconds or shorter for a sticker.");
          }
        }

        await reactMsg(sock, from, msg, "⏳");

        const messageToDownload = (quotedImg || quotedVid)
          ? { key: msg.key, message: quotedMsg }
          : msg;

        const buffer = await downloadMediaMessage(messageToDownload, "buffer", {});

        const tmpIn  = join(tmpdir(), `sticker_in_${Date.now()}.${isVideo ? "mp4" : "jpg"}`);
        const tmpOut = join(tmpdir(), `sticker_out_${Date.now()}.webp`);

        writeFileSync(tmpIn, buffer);

        if (isVideo) {
          execSync(
            `ffmpeg -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=10" -vcodec libwebp -lossless 0 -compression_level 6 -q:v 50 -loop 0 -preset picture -an -vsync 0 -t 10 "${tmpOut}" -y`,
            { timeout: 30000 }
          );
        } else {
          await sharp(tmpIn)
            .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80 })
            .toFile(tmpOut);
        }

        let webpBuffer = readFileSync(tmpOut);
        try { unlinkSync(tmpIn); } catch {}
        try { unlinkSync(tmpOut); } catch {}

        // Apply sticker pack metadata
        const packName   = cachedGetSetting("sticker_pack_name", "Bot Stickers");
        const authorName = cachedGetSetting("sticker_pack_author", "WhatsApp Bot");
        webpBuffer = addStickerMetadata(webpBuffer, packName, authorName);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { sticker: webpBuffer }, { quoted: msg });

      } catch (err) {
        console.error("❌ Sticker error:", err.message);
        await replyMsg(sock, from, msg, `❌ Failed to convert to sticker: ${err.message}`);
        await alertOwner(sock, `${prefix || "!"}sticker`, err);
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
        `📖 *How to use ${prefix}setpackname*\n\n🔧 *Syntax:*\n${prefix}setpackname <name>`
      );
      try {
        await setSetting("sticker_pack_name", name);
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Sticker pack name set to: *${name}*`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setpackname`, err);
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
        `📖 *How to use ${prefix}setpackauthor*\n\n🔧 *Syntax:*\n${prefix}setpackauthor <name>`
      );
      try {
        await setSetting("sticker_pack_author", name);
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Sticker author name set to: *${name}*`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setpackauthor`, err);
      }
    },
  },

};
