import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

async function getMediaBuffer(msg) {
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasImage = !!(msg.message?.imageMessage || quotedMsg?.imageMessage);
  
  if (!hasImage) return null;
  const msgToDownload = quotedMsg?.imageMessage ? { key: msg.key, message: quotedMsg } : msg;
  const buffer = await downloadMediaMessage(msgToDownload, "buffer", {});
  return buffer;
}

export const imageFxCommands = {
  wasted: {
    adminOnly: false,
    requiresArgs: false,
    description: "Apply the GTA WASTED filter to an image",
    usage: "!wasted",
    examples: ["Reply to an image with !wasted"],
    handler: async (sock, msg, args, from, prefix) => {
      const buffer = await getMediaBuffer(msg);
      if (!buffer) return replyMsg(sock, from, msg, `📖 *${prefix}wasted*\n\nReply to an image with *${prefix}wasted*`);

      await reactMsg(sock, from, msg, "⏳");

      try {
        const metadata = await sharp(buffer).metadata();
        const width = metadata.width || 512;
        const height = metadata.height || 512;

        const fontSize = Math.max(Math.floor(width / 6), 40);
        const svgText = `
          <svg width="${width}" height="${height}">
            <style>
              .text {
                font-family: Impact, Arial, sans-serif;
                font-size: ${fontSize}px;
                font-weight: bold;
                fill: #e82c2c;
                stroke: black;
                stroke-width: ${Math.max(fontSize / 15, 2)}px;
                text-anchor: middle;
                dominant-baseline: middle;
                letter-spacing: ${fontSize / 5}px;
              }
            </style>
            <text x="${width / 2}" y="${height / 2}" class="text">WASTED</text>
          </svg>
        `;

        const outBuffer = await sharp(buffer)
          .grayscale()
          .tint({ r: 100, g: 100, b: 100 }) // darken slightly
          .composite([{
            input: Buffer.from(svgText),
            gravity: 'center'
          }])
          .jpeg({ quality: 90 })
          .toBuffer();

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          image: outBuffer,
          mimetype: "image/jpeg"
        }, { quoted: msg });
      } catch (err) {
        console.error("❌ wasted error:", err.message);
        await failMsg(sock, from, msg, err, "wasted");
      }
    },
  },

  triggered: {
    adminOnly: false,
    requiresArgs: false,
    description: "Apply the TRIGGERED shaking filter to an image",
    usage: "!triggered",
    examples: ["Reply to an image with !triggered"],
    handler: async (sock, msg, args, from, prefix) => {
      const buffer = await getMediaBuffer(msg);
      if (!buffer) return replyMsg(sock, from, msg, `📖 *${prefix}triggered*\n\nReply to an image with *${prefix}triggered*`);

      await reactMsg(sock, from, msg, "⏳");

      const ts = Date.now();
      const tmpIn = join(tmpdir(), `trig_in_${ts}.png`);
      const tmpOut = join(tmpdir(), `trig_out_${ts}.mp4`);

      try {
        // Pre-process with sharp to ensure it's a valid RGB PNG and add the TRIGGERED banner
        const metadata = await sharp(buffer).metadata();
        const width = metadata.width || 512;
        const height = metadata.height || 512;
        const bannerHeight = Math.max(Math.floor(height / 5), 50);

        const svgBanner = `
          <svg width="${width}" height="${height}">
            <rect x="0" y="${height - bannerHeight}" width="${width}" height="${bannerHeight}" fill="#000000" fill-opacity="0.6"/>
            <text x="${width / 2}" y="${height - (bannerHeight / 2)}" font-family="Arial, sans-serif" font-weight="bold" font-size="${bannerHeight * 0.6}px" fill="#ff0000" text-anchor="middle" dominant-baseline="middle" letter-spacing="4px" font-style="italic">TRIGGERED</text>
          </svg>
        `;

        const processedBuffer = await sharp(buffer)
          .composite([{ input: Buffer.from(svgBanner), gravity: 'south' }])
          .png()
          .toBuffer();

        writeFileSync(tmpIn, processedBuffer);

        // Use ffmpeg to apply red tint, loop it, and add violent shake (crop with sine/cosine)
        // Crop box is slightly smaller than image to allow room for shaking
        execSync(
          `ffmpeg -loop 1 -i "${tmpIn}" -vf "drawbox=x=0:y=0:w=iw:h=ih:color=red@0.3:t=fill,crop=iw-40:ih-40:20+20*sin(t*30):20+20*cos(t*40)" -t 2 -r 15 -c:v libx264 -pix_fmt yuv420p "${tmpOut}" -y`,
          { timeout: 30000 }
        );

        const outBuffer = readFileSync(tmpOut);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          video: outBuffer,
          mimetype: "video/mp4",
          gifPlayback: true
        }, { quoted: msg });

      } catch (err) {
        console.error("❌ triggered error:", err.message);
        await failMsg(sock, from, msg, err, "triggered");
      } finally {
        try { unlinkSync(tmpIn); } catch {}
        try { unlinkSync(tmpOut); } catch {}
      }
    },
  },
};
