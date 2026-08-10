import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fsPromises, existsSync } from "fs";

const execFileAsync = promisify(execFile);
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import sharp from "sharp";

export const qrCommands = {

  qr: {
    adminOnly: false,
    requiresArgs: false,
    description: "Generate a QR code from text, or decode a QR code from an image",
    usage: "!qr <text>  OR  reply to an image with !qr",
    examples: [
      "!qr https://github.com/d-gibr1l",
      "!qr Hello World",
      "Reply to a QR image → !qr",
    ],
    handler: async (sock, msg, args, from, prefix) => {
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const hasImage  = !!(msg.message?.imageMessage || quotedMsg?.imageMessage);

      // ── Decode mode — reply to image ────────────────────────────────────────
      if (hasImage && args.length === 0) {
        await reactMsg(sock, from, msg, "🔍");
        try {
          const msgToDownload = quotedMsg?.imageMessage
            ? { key: msg.key, message: quotedMsg }
            : msg;
          const buffer = await downloadMediaMessage(msgToDownload, "buffer", {});

          const tmpImg = join(tmpdir(), `qr_in_${Date.now()}.png`);
          const pngBuf = await sharp(buffer).png().toBuffer();
          await fsPromises.writeFile(tmpImg, pngBuf);

          try {
            const { stdout } = await execFileAsync("zbarimg", ["--quiet", "--raw", tmpImg], {
              timeout: 10000, encoding: "utf8"
            });
            result = stdout.trim();
          } catch (err) {
            // zbarimg exits with code 4 if no barcodes are found, ignore it and handle as empty result
            if (err.code !== 4) console.error("zbarimg error:", err);
            result = "";
          }

          await fsPromises.unlink(tmpImg).catch(()=>{});

          if (!result) {
            return replyMsg(sock, from, msg, "❌ No QR code found in image. Make sure the QR is clear and well-lit.");
          }

          await reactMsg(sock, from, msg, "✅");
          await replyMsg(sock, from, msg, `✅ *QR Code Decoded:*\n\n${result}`);
        } catch (err) {
          await failMsg(sock, from, msg, err, "qr decode");
        }
        return;
      }

      // ── Generate mode ───────────────────────────────────────────────────────
      const text = args.join(" ").trim();
      if (!text) return replyMsg(sock, from, msg,
        `📖 *${prefix}qr*\n\n` +
        `*Generate:* ${prefix}qr <text or URL>\n` +
        `*Decode:* Reply to a QR image with ${prefix}qr\n\n` +
        `💡 Examples:\n• ${prefix}qr https://github.com\n• ${prefix}qr Hello World`
      );

      await reactMsg(sock, from, msg, "⏳");
      try {
        const tmpOut = join(tmpdir(), `qr_out_${Date.now()}.png`);
        
        await execFileAsync("qrencode", ["-o", tmpOut, "-s", "10", text], { timeout: 10000 });

        if (!existsSync(tmpOut)) throw new Error("qrencode failed to produce output.");

        const buffer = await fsPromises.readFile(tmpOut);
        await fsPromises.unlink(tmpOut).catch(()=>{});

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, {
          image: buffer,
          caption: `🔳 *QR Code*\n${text.length > 60 ? text.slice(0, 60) + "..." : text}`,
        }, { quoted: msg });
      } catch (err) {
        // qrencode not installed — use online API as fallback
        try {
          const encoded = encodeURIComponent(text);
          const res = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}`);
          if (!res.ok) throw new Error("QR API failed");
          const buffer = Buffer.from(await res.arrayBuffer());
          await reactMsg(sock, from, msg, "✅");
          await sock.sendMessage(from, {
            image: buffer,
            caption: `🔳 *QR Code*\n${text.length > 60 ? text.slice(0, 60) + "..." : text}`,
          }, { quoted: msg });
        } catch (err2) {
          await failMsg(sock, from, msg, err2, "qr generate");
        }
      }
    },
  },

};
