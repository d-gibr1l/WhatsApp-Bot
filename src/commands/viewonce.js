import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { replyMsg, alertOwner } from "./helpers.js";

export const viewonceCommands = {

  viewonce: {
    adminOnly: false,
    requiresArgs: false,
    description: "Reveal a view-once image or video by replying to it",
    usage: "!viewonce",
    examples: ["Reply to a view-once message with: !viewonce"],
    notes: "Only works when replying to a view-once message.",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quoted      = contextInfo?.quotedMessage;

        if (!quoted) return replyMsg(sock, from, msg,
          `📖 *How to use ${prefix}viewonce*\n\n📌 Reply to a view-once message with *${prefix}viewonce* to reveal it.`
        );

        // Unwrap all known view-once envelope types
        const voMsg =
          quoted.viewOnceMessage?.message ??
          quoted.viewOnceMessageV2?.message ??
          quoted.viewOnceMessageV2Extension?.message ??
          null;

        // Also handle if the quoted IS the media directly (some WA versions)
        const directImage = quoted.imageMessage;
        const directVideo = quoted.videoMessage;

        const mediaMessage = voMsg?.imageMessage ?? voMsg?.videoMessage
                          ?? directImage ?? directVideo ?? null;

        if (!mediaMessage) return replyMsg(sock, from, msg,
          `❌ No view-once media found.\n\n📌 Make sure you're replying to a view-once image or video.`
        );

        const isVideo = !!(voMsg?.videoMessage ?? directVideo);

        // Build correct key for download — must use the original stanzaId
        const fakeMsg = {
          key: {
            remoteJid: from,
            id:        contextInfo.stanzaId,
            fromMe:    false,
            participant: contextInfo.participant,
          },
          message: voMsg ?? quoted,
        };

        const buffer = await downloadMediaMessage(fakeMsg, "buffer", {});

        if (isVideo) {
          await sock.sendMessage(from, {
            video:    buffer,
            mimetype: mediaMessage.mimetype ?? "video/mp4",
            caption:  "👁️ View-once video revealed",
          }, { quoted: msg });
        } else {
          await sock.sendMessage(from, {
            image:    buffer,
            mimetype: mediaMessage.mimetype ?? "image/jpeg",
            caption:  "👁️ View-once image revealed",
          }, { quoted: msg });
        }

      } catch (err) {
        console.error("❌ Viewonce error:", err.message);
        await replyMsg(sock, from, msg, `❌ Failed to reveal media: ${err.message}`);
        await alertOwner(sock, `${prefix}viewonce`, err);
      }
    },
  },

};
