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
        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");

        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) return replyMsg(sock, from, msg,
          `📖 *How to use ${prefix}viewonce*\n\n📌 Reply to a view-once message with *${prefix}viewonce* to reveal it.`
        );

        // Check for view-once image or video
        const voImage = quoted?.viewOnceMessage?.message?.imageMessage
                     ?? quoted?.viewOnceMessageV2?.message?.imageMessage
                     ?? quoted?.viewOnceMessageV2Extension?.message?.imageMessage;

        const voVideo = quoted?.viewOnceMessage?.message?.videoMessage
                     ?? quoted?.viewOnceMessageV2?.message?.videoMessage
                     ?? quoted?.viewOnceMessageV2Extension?.message?.videoMessage;

        const media = voImage || voVideo;
        const isVideo = !!voVideo;

        if (!media) return replyMsg(sock, from, msg,
          `❌ No view-once media found.\n\n📌 Make sure you're replying to a view-once image or video.`
        );

        // Build a fake msg object to download from
        const fakeMsg = {
          key: msg.key,
          message: quoted?.viewOnceMessage?.message
                ?? quoted?.viewOnceMessageV2?.message
                ?? quoted?.viewOnceMessageV2Extension?.message,
        };

        const buffer = await downloadMediaMessage(fakeMsg, "buffer", {});

        if (isVideo) {
          await sock.sendMessage(from, {
            video: buffer,
            mimetype: media.mimetype || "video/mp4",
            caption: "👁️ View-once video revealed",
          }, { quoted: msg });
        } else {
          await sock.sendMessage(from, {
            image: buffer,
            mimetype: media.mimetype || "image/jpeg",
            caption: "👁️ View-once image revealed",
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
