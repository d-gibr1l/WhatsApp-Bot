export default {
  name: "stealthrevive",
  alias: ["//"],
  description: "Reply to a View Once with .// to silently save it to your DM",

  start: async (Hooper, m, { isCreator }) => {
    try {
      // Owner only
      if (!isCreator) return;

      // .// only works as a reply to a message. Never answer in the
      // originating chat (that would announce the command); hint privately
      // and, in a group, quietly delete the trigger if we can.
      if (!m.quoted) {
        if (m.isGroup) {
          try {
            await Hooper.sendMessage(m.from, { delete: m.key });
          } catch (e) {}
        }
        try {
          await Hooper.sendMessage(m.sender, {
            text: "ℹ️ Reply to a View Once message with .// to save it silently.",
          });
        } catch (e) {}
        return;
      }

      const mime = m.quoted.msg?.mimetype || m.quoted.mimetype || "";
      const isMedia = /image|video|audio|sticker/.test(mime) || m.quoted.type?.toLowerCase().includes("viewonce");

      if (!isMedia) {
        // Normal text message — forward it to the owner's DM
        if (m.quoted.copyNForward) {
          await m.quoted.copyNForward(m.sender, true);
          console.log(`[ STEALTH ] Forwarded text message to ${m.sender}`);
        } else {
          await Hooper.sendMessage(m.sender, {
            forward: m.quoted.fakeObj || {
              key: { remoteJid: m.chat, id: m.quoted.id, fromMe: m.quoted.fromMe, participant: m.quoted.sender },
              message: m.msg?.contextInfo?.quotedMessage,
            },
          });
        }
        return;
      }

      let buffer;
      try {
        buffer = await Hooper.downloadMediaMessage(m.quoted.msg || m.quoted);
      } catch (err) {
        console.error("[ STEALTH ] Failed to download media:", err);
        try {
          await Hooper.sendMessage(m.sender, { text: `⚠️ Failed to download media: ${err.message}` }, { quoted: m });
        } catch (e) {}
        return;
      }

      if (!buffer || !buffer.length) {
        console.error("[ STEALTH ] Buffer is empty");
        return;
      }

      const captionText = m.quoted.msg?.caption || m.quoted.text || "";
      const originalCaption = captionText ? `\n\n${captionText}` : "";
      const isViewOnce = m.quoted.msg?.viewOnce || m.quoted.type?.toLowerCase().includes("viewonce");
      const senderNumber = m.quoted.sender.split("@")[0];

      const caption = isViewOnce
        ? `viewonce saved from @${senderNumber}${originalCaption}`
        : `saved from @${senderNumber}.\n------------------------${originalCaption}`;

      const targetJid = m.sender;
      const messageOptions = { caption, mentions: [m.quoted.sender] };

      if (/image/.test(mime) || (m.quoted.type === "viewOnceMessageV2" && m.quoted.msg?.mimetype?.includes("image"))) {
        await Hooper.sendMessage(targetJid, { image: buffer, ...messageOptions });
      } else if (/video/.test(mime) || (m.quoted.type === "viewOnceMessageV2" && m.quoted.msg?.mimetype?.includes("video"))) {
        await Hooper.sendMessage(targetJid, { video: buffer, ...messageOptions });
      } else if (/audio/.test(mime)) {
        await Hooper.sendMessage(targetJid, { audio: buffer, mimetype: "audio/mp4", ptt: true });
        if (captionText) await Hooper.sendMessage(targetJid, { text: caption, mentions: messageOptions.mentions });
      } else {
        await Hooper.sendMessage(targetJid, { document: buffer, mimetype: mime || "application/octet-stream", fileName: "stealth_media", ...messageOptions });
      }

      console.log(`[ STEALTH ] Successfully sent media to ${targetJid}`);
    } catch (e) {
      console.error("[ STEALTH ] Crash:", e);
      try {
        await Hooper.sendMessage(m.sender, { text: `⚠️ Stealth Revive Error:\n${e.message || String(e)}` }, { quoted: m });
      } catch (err) {}
    }
  },

  // Owner can also react 🕵️‍♂️ / 👀 to a message to save it to their DM
  reaction: async (Hooper, m) => {
    if (!global.owner?.includes(m.sender.split("@")[0]) && m.sender !== Hooper.user.id.replace(/:.*@/, "@")) return;
    if (m.msg?.text !== "🕵️‍♂️" && m.msg?.text !== "👀") return;

    try {
      console.log(`[ STEALTH REACTION ] Triggered by ${m.sender}`);

      const targetMessageKey = m.msg?.key;
      if (!targetMessageKey) return;

      const { messageData } = await import("../System/MongoDB/MongoDB_Schema.js");
      const doc = await messageData.findOne({ id: targetMessageKey.id, chatId: targetMessageKey.remoteJid }).lean();

      const reviveBuffers = (obj) => {
        if (!obj || typeof obj !== "object") return obj;
        if (Buffer.isBuffer(obj)) return obj;
        if (obj._bsontype === "Binary" && obj.buffer) return Buffer.from(obj.buffer);
        if (obj.type === "Buffer" && Array.isArray(obj.data)) return Buffer.from(obj.data);
        for (const k in obj) obj[k] = reviveBuffers(obj[k]);
        return obj;
      };

      const targetMessage = doc ? reviveBuffers(doc.data) : null;
      if (!targetMessage) {
        console.log(`[ STEALTH REACTION ] Could not find message in store`);
        return;
      }

      const { serialize } = await import("../System/whatsapp.js");
      const qMsg = serialize(Hooper, targetMessage);
      if (!qMsg) return;

      const mime = qMsg.msg?.mimetype || qMsg.mimetype || "";
      const isMedia = /image|video|audio|sticker/.test(mime) || qMsg.type?.toLowerCase().includes("viewonce");

      if (!isMedia) {
        await Hooper.sendMessage(m.sender, { forward: targetMessage });
        return;
      }

      const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");

      let downloadType = "image";
      if (/video/.test(mime)) downloadType = "video";
      else if (/audio/.test(mime)) downloadType = "audio";
      else if (/document/.test(mime)) downloadType = "document";
      else if (/sticker/.test(mime)) downloadType = "sticker";

      const stream = await downloadContentFromMessage(qMsg.msg || qMsg, downloadType);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) return;

      const captionText = qMsg.msg?.caption || qMsg.text || "";
      const originalCaption = captionText ? `\n\n${captionText}` : "";
      const isViewOnce = qMsg.msg?.viewOnce || qMsg.type?.toLowerCase().includes("viewonce");
      const senderNumber = qMsg.sender.split("@")[0];

      const caption = isViewOnce
        ? `viewonce saved from @${senderNumber}${originalCaption}`
        : `saved from @${senderNumber}.\n------------------------${originalCaption}`;

      const messageOptions = { caption, mentions: [qMsg.sender] };
      const targetJid = m.sender;

      if (downloadType === "image") {
        await Hooper.sendMessage(targetJid, { image: buffer, ...messageOptions });
      } else if (downloadType === "video") {
        await Hooper.sendMessage(targetJid, { video: buffer, ...messageOptions });
      } else if (downloadType === "audio") {
        await Hooper.sendMessage(targetJid, { audio: buffer, mimetype: "audio/mp4", ptt: true });
        if (captionText) await Hooper.sendMessage(targetJid, { text: caption, mentions: messageOptions.mentions });
      } else {
        await Hooper.sendMessage(targetJid, { document: buffer, mimetype: mime || "application/octet-stream", fileName: "stealth_media", ...messageOptions });
      }

      console.log(`[ STEALTH REACTION ] Successfully sent media to ${targetJid}`);
    } catch (e) {
      console.error("[ STEALTH REACTION ] Error:", e);
    }
  },
};
