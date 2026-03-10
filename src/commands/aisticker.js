import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// ─── Pollinations.ai image generation (free, no key needed) ──────────────────

async function generateImage(prompt) {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=512&height=512&nologo=true&enhance=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!res.ok) throw new Error(`Image generation failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const aistickerCommands = {

  aisticker: {
    adminOnly: false,
    requiresArgs: true,
    description: "Generate an AI image and send it as a WhatsApp sticker",
    usage: "!aisticker <prompt>",
    examples: [
      "!aisticker a pirate cat smoking a cigar",
      "!aisticker cute dog wearing sunglasses",
      "!aisticker anime warrior girl in forest",
    ],
    notes: "Powered by Pollinations.ai — free, no API key needed. May take 10-20 seconds.",
    handler: async (sock, msg, args, from, prefix) => {
      const prompt = args.join(" ").trim();
      if (!prompt) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}aisticker*\n\n🔧 *Syntax:*\n${prefix}aisticker <description>\n\n💡 *Examples:*\n• ${prefix}aisticker a pirate cat smoking a cigar\n• ${prefix}aisticker cute dog wearing sunglasses`
      );

      await reactMsg(sock, from, msg, "🎨");

      const tmpOut = join(tmpdir(), `aisticker_${Date.now()}.webp`);

      try {
        // Generate image
        const imageBuffer = await generateImage(prompt);

        // Convert to sticker WebP
        await sharp(imageBuffer)
          .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 80 })
          .toFile(tmpOut);

        const webpBuffer = readFileSync(tmpOut);
        try { unlinkSync(tmpOut); } catch {}

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { sticker: webpBuffer }, { quoted: msg });

      } catch (err) {
        try { if (existsSync(tmpOut)) unlinkSync(tmpOut); } catch {}
        console.error("❌ AI sticker error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Failed to generate sticker: ${err.message}`);
        await alertOwner(sock, `${prefix}aisticker`, err);
      }
    },
  },

  aiimage: {
    adminOnly: false,
    requiresArgs: true,
    description: "Generate an AI image from a text prompt",
    usage: "!aiimage <prompt>",
    examples: [
      "!aiimage sunset over the ocean",
      "!aiimage futuristic city at night",
    ],
    notes: "Powered by Pollinations.ai — free, no API key needed.",
    handler: async (sock, msg, args, from, prefix) => {
      const prompt = args.join(" ").trim();
      if (!prompt) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}aiimage*\n\n🔧 *Syntax:*\n${prefix}aiimage <description>`
      );

      await reactMsg(sock, from, msg, "🎨");

      try {
        const imageBuffer = await generateImage(prompt);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          image: imageBuffer,
          caption: `🎨 _${prompt}_`,
        }, { quoted: msg });

      } catch (err) {
        console.error("❌ AI image error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Failed to generate image: ${err.message}`);
        await alertOwner(sock, `${prefix}aiimage`, err);
      }
    },
  },

};
