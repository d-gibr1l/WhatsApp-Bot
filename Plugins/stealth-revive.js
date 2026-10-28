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
};
