import { extractMessageContent, downloadContentFromMessage, getContentType } from "@whiskeysockets/baileys";
import { getSetting, setSetting } from "../src/db.js";

export default {
  name: "stealthrevive",
  alias: [".//", ".///"],
  uniquecommands: ["stealthrevive", ".//", ".///"],
  description: "Silently send view once messages to DMs or toggle Auto-Stealth",

  start: async (Hooper, m, { inputCMD, quoted, doReact, prefix, isCreator }) => {
    try {
      // Only the bot owner can use this command
      if (!isCreator) return;

      // Handle Auto-Stealth Toggle
      if (inputCMD === ".///") {
        const currentState = await getSetting("auto_stealth", false);
        const newState = !currentState;
        await setSetting("auto_stealth", newState);
        
        await Hooper.sendMessage(m.sender, { 
          text: `👁️ *Auto-Stealth Mode: ${newState ? "ON" : "OFF"}*\n\n${newState ? "All incoming View Once messages will now be automatically downloaded and silently forwarded to this chat." : "Auto-Stealth has been disabled."}` 
        });
        return;
      }

      // Must be a reply to a message for single revive
      if (!m.quoted) return;

      // Get the raw quoted message from contextInfo
      const contextInfo = m.msg?.contextInfo;
      if (!contextInfo?.quotedMessage) return;

      const rawQuoted = contextInfo.quotedMessage;
      const quotedType = getContentType(rawQuoted);

      // Case 1: Wrapped in viewOnceMessage / viewOnceMessageV2 container
      const isWrappedViewOnce =
        quotedType === "viewOnceMessage" ||
        quotedType === "viewOnceMessageV2" ||
        quotedType === "viewOnceMessageV2Extension";

      // Case 2: Already unwrapped
      const innerMsg = rawQuoted[quotedType];
      const isUnwrappedViewOnce =
        !isWrappedViewOnce &&
        (quotedType === "imageMessage" || quotedType === "videoMessage" || quotedType === "audioMessage" || quotedType === "ptvMessage");

      if (!isWrappedViewOnce && !isUnwrappedViewOnce) {
        // If it's a normal message, just forward it directly to the user's DM
        try {
          if (m.quoted.copyNForward) {
            await m.quoted.copyNForward(m.sender, true);
          } else {
            // Fallback if copyNForward isn't available
            await Hooper.sendMessage(m.sender, { forward: { key: { remoteJid: m.chat, id: m.quoted.id, fromMe: m.quoted.isSelf, participant: m.quoted.sender }, message: rawQuoted } });
          }
        } catch (e) {
          console.log("[ STEALTH ] Failed to forward normal message", e);
        }
        return;
      }

      let mediaMsg, isImage, isVideo, isAudio;

      if (isWrappedViewOnce) {
        const extracted = extractMessageContent(rawQuoted);
        const mediaType = getContentType(extracted);
        mediaMsg = extracted[mediaType];
        isImage = mediaType.includes("image");
        isVideo = mediaType.includes("video");
        isAudio = mediaType.includes("audio");
      } else {
        mediaMsg = innerMsg;
        isImage = quotedType === "imageMessage";
        isVideo = quotedType === "videoMessage" || quotedType === "ptvMessage";
        isAudio = quotedType === "audioMessage";
      }

      if (!mediaMsg) return;

      // Download the media content
      let downloadType = "image";
      if (isVideo) downloadType = "video";
      if (isAudio) downloadType = "audio";
      
      const stream = await downloadContentFromMessage(
        mediaMsg,
        downloadType
      );
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      let buffer = Buffer.concat(chunks);

      if (!buffer.length) return;

      // Send to m.sender's DM silently
      // No caption, no reaction, no quote reference (so it's fully stealth)
      const targetJid = m.sender;
      
      // We will include the original caption just in case it had text
      const originalCaption = mediaMsg.caption ? `\n\n${mediaMsg.caption}` : "";
      const caption = `👁️ *View Once Saved*${originalCaption}`;

      if (isImage) {
        await Hooper.sendMessage(targetJid, { image: buffer, caption: caption });
      } else if (isVideo) {
        await Hooper.sendMessage(targetJid, { video: buffer, caption: caption });
      } else if (isAudio) {
        await Hooper.sendMessage(targetJid, { audio: buffer, mimetype: "audio/mp4", ptt: true });
        if (originalCaption) await Hooper.sendMessage(targetJid, { text: caption });
      }

      // NO doReact("✅") or m.reply() to stay fully stealth!

    } catch (e) {
      // Silently fail
    }
  },
};
