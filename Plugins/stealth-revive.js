import { getSetting, setSetting } from "../src/db.js";

export default {
  name: "stealthrevive",
  alias: [".//", ".///"],
  uniquecommands: ["stealthrevive", ".//", ".///"],
  description: "Silently send view once messages to DMs or toggle Auto-Stealth",

  start: async (Hooper, m, { inputCMD, doReact, isCreator }) => {
    try {
      console.log(`[ STEALTH ] Triggered by ${m.sender} with cmd: ${inputCMD}`);
      
      // Only the bot owner can use this command
      if (!isCreator) {
        console.log(`[ STEALTH ] Rejected: not creator`);
        return;
      }

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
      if (!m.quoted) {
        console.log("[ STEALTH ] No quoted message found.");
        return;
      }

      const mime = m.quoted.msg?.mimetype || m.quoted.mimetype || "";
      const isMedia = /image|video|audio|sticker/.test(mime) || m.quoted.type?.toLowerCase().includes("viewonce");

      if (!isMedia) {
        // If it's a normal text message, just forward it directly to the user's DM
        if (m.quoted.copyNForward) {
          await m.quoted.copyNForward(m.sender, true);
          console.log(`[ STEALTH ] Forwarded text message to ${m.sender}`);
        } else {
           // Fallback for forwarding
           await Hooper.sendMessage(m.sender, { forward: m.quoted.fakeObj || { key: { remoteJid: m.chat, id: m.quoted.id, fromMe: m.quoted.fromMe, participant: m.quoted.sender }, message: m.msg?.contextInfo?.quotedMessage } });
        }
        return;
      }

      // Download the media using Baileys' built-in reliable downloader
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

      // Extract caption if any
      const captionText = m.quoted.msg?.caption || m.quoted.text || "";
      const originalCaption = captionText ? `\n\n${captionText}` : "";
      const caption = `👁️ *View Once Saved*${originalCaption}`;

      const targetJid = m.sender;

      // Send to m.sender's DM silently
      // No caption (unless original), no reaction, no quote reference (so it's fully stealth)
      if (/image/.test(mime) || (m.quoted.type === 'viewOnceMessageV2' && m.quoted.msg?.mimetype?.includes('image'))) {
        await Hooper.sendMessage(targetJid, { image: buffer, caption: caption });
      } else if (/video/.test(mime) || (m.quoted.type === 'viewOnceMessageV2' && m.quoted.msg?.mimetype?.includes('video'))) {
        await Hooper.sendMessage(targetJid, { video: buffer, caption: caption });
      } else if (/audio/.test(mime)) {
        await Hooper.sendMessage(targetJid, { audio: buffer, mimetype: "audio/mp4", ptt: true });
        if (captionText) await Hooper.sendMessage(targetJid, { text: caption });
      } else {
        await Hooper.sendMessage(targetJid, { document: buffer, mimetype: mime || 'application/octet-stream', fileName: "stealth_media", caption: caption });
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
