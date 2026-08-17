import { getSetting, setSetting } from "../src/db.js";

export default {
  name: "stealthrevive",
  alias: ["//", "///", "stealth"],
  uniquecommands: ["stealthrevive", "//", "///", "stealth"],
  description: "Silently send view once messages to DMs or toggle Auto-Stealth",

  start: async (Hooper, m, { inputCMD, text, doReact, isCreator, mentionByTag }) => {
    try {
      console.log(`[ STEALTH ] Triggered by ${m.sender} with cmd: ${inputCMD}`);
      
      // Only the bot owner can use this command
      if (!isCreator) {
        console.log(`[ STEALTH ] Rejected: not creator`);
        return;
      }

      // Handle Auto-Stealth Toggles
      if (inputCMD === "///" || inputCMD === "stealth") {
        let targetJid = m.from; // Default to current chat
        let isGlobal = false;
        
        if (text) {
          if (text.toLowerCase() === "all") {
             isGlobal = true;
          } else if (mentionByTag && mentionByTag.length > 0) {
             targetJid = mentionByTag[0];
          } else {
             const cleanedNumber = text.replace(/[^0-9]/g, "");
             if (cleanedNumber) targetJid = cleanedNumber + (cleanedNumber.length > 15 ? "@g.us" : "@s.whatsapp.net");
          }
        }

        if (isGlobal) {
          const currentState = await getSetting("auto_stealth", false);
          const newState = !currentState;
          await setSetting("auto_stealth", newState);
          
          await Hooper.sendMessage(m.sender, { 
            text: `👁️ *Global Auto-Stealth: ${newState ? "ON" : "OFF"}*\n\n${newState ? "All incoming View Once messages from ALL chats will be silently forwarded to you." : "Global Auto-Stealth disabled."}` 
          });
        } else {
          // Toggle for specific JID
          let targetsStr = await getSetting("auto_stealth_targets", "");
          let targets = targetsStr ? targetsStr.split(",") : [];
          
          let enabled = false;
          if (targets.includes(targetJid)) {
             targets = targets.filter(j => j !== targetJid);
          } else {
             targets.push(targetJid);
             enabled = true;
          }
          
          await setSetting("auto_stealth_targets", targets.join(","));
          
          await Hooper.sendMessage(m.sender, { 
            text: `👁️ *Auto-Stealth for @${targetJid.split("@")[0]}: ${enabled ? "ON" : "OFF"}*\n\n${enabled ? "View Once messages from this chat will be silently forwarded to you." : "Auto-Stealth disabled for this chat."}`,
            mentions: [targetJid]
          });
        }
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
      
      const isViewOnce = m.quoted.msg?.viewOnce || m.quoted.type?.toLowerCase().includes("viewonce");
      const senderNumber = m.quoted.sender.split("@")[0];
      
      const caption = isViewOnce 
         ? `viewonce saved from @${senderNumber}${originalCaption}`
         : `saved from @${senderNumber}.\n------------------------${originalCaption}`;

      const targetJid = m.sender;

      // Send to m.sender's DM silently
      // No caption (unless original), no reaction, no quote reference (so it's fully stealth)
      const messageOptions = { caption: caption, mentions: [m.quoted.sender] };

      if (/image/.test(mime) || (m.quoted.type === 'viewOnceMessageV2' && m.quoted.msg?.mimetype?.includes('image'))) {
        await Hooper.sendMessage(targetJid, { image: buffer, ...messageOptions });
      } else if (/video/.test(mime) || (m.quoted.type === 'viewOnceMessageV2' && m.quoted.msg?.mimetype?.includes('video'))) {
        await Hooper.sendMessage(targetJid, { video: buffer, ...messageOptions });
      } else if (/audio/.test(mime)) {
        await Hooper.sendMessage(targetJid, { audio: buffer, mimetype: "audio/mp4", ptt: true });
        if (captionText) await Hooper.sendMessage(targetJid, { text: caption, mentions: messageOptions.mentions });
      } else {
        await Hooper.sendMessage(targetJid, { document: buffer, mimetype: mime || 'application/octet-stream', fileName: "stealth_media", ...messageOptions });
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
