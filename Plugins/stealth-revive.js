import { getSetting, setSetting, getBoolSetting } from "../src/db.js";

export default {
  name: "stealthrevive",
  alias: ["//", "///", "stealth"],
  uniquecommands: ["stealth"],
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
      if (inputCMD === "///" || (inputCMD === "stealth" && (text || !m.quoted))) {
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
          const currentState = await getBoolSetting("auto_stealth", false);
          const newState = !currentState;
          await setSetting("auto_stealth", newState ? "true" : "false");
          
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

      // Handle manual stealth (using .//) on a quoted message.
      // Never reply in the originating chat — that would broadcast that a
      // stealth command was used. Send the hint to the owner privately and,
      // in a group, quietly remove the trigger message if we can.
      if (!m.quoted) {
        if (m.isGroup) {
          try {
            await Hooper.sendMessage(m.from, { delete: m.key });
          } catch (e) {}
        }
        try {
          await Hooper.sendMessage(m.sender, {
            text: "ℹ️ Reply to a View Once message with this command to intercept it silently.",
          });
        } catch (e) {}
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
  
  // Also hook into reactions so users can react with 🕵️‍♂️ to stealth a message
  reaction: async (Hooper, m) => {
    // Determine if it's the bot owner reacting
    const { isCreator } = await import("../System/MongoDB/MongoDb_Core.js").then(mod => ({ isCreator: mod.checkMod(m.sender) }));
    if (!global.owner?.includes(m.sender.split('@')[0]) && m.sender !== Hooper.user.id.replace(/:.*@/, "@")) return;
    
    // You can define what reaction triggers it, e.g. 🕵️‍♂️ or 👀
    if (m.msg?.text !== "🕵️‍♂️" && m.msg?.text !== "👀") return;

    try {
      console.log(`[ STEALTH REACTION ] Triggered by ${m.sender}`);
      
      const targetMessageKey = m.msg?.key; // the key of the message being reacted to
      if (!targetMessageKey) return;

      // Fetch the original message from MongoDB
      const { messageData } = await import("../System/MongoDB/MongoDB_Schema.js");
      const doc = await messageData.findOne({ id: targetMessageKey.id, chatId: targetMessageKey.remoteJid }).lean();
      
      const reviveBuffers = (obj) => {
         if (!obj || typeof obj !== 'object') return obj;
         if (Buffer.isBuffer(obj)) return obj;
         if (obj._bsontype === 'Binary' && obj.buffer) return Buffer.from(obj.buffer);
         if (obj.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
         for (const k in obj) obj[k] = reviveBuffers(obj[k]);
         return obj;
      };

      let targetMessage = doc ? reviveBuffers(doc.data) : null;

      if (!targetMessage) {
         console.log(`[ STEALTH REACTION ] Could not find message in store`);
         return;
      }

      const { serialize } = await import("../System/whatsapp.js");
      const qMsg = serialize(Hooper, targetMessage);
      if(!qMsg) return;

      const mime = qMsg.msg?.mimetype || qMsg.mimetype || "";
      const isMedia = /image|video|audio|sticker/.test(mime) || qMsg.type?.toLowerCase().includes("viewonce");
      
      if (!isMedia) {
        // Text forwarding via reaction
        await Hooper.sendMessage(m.sender, { forward: targetMessage });
        return;
      }

      const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
      
      // Attempt download directly (downloadMediaMessage sometimes expects it to be inside `m.quoted`)
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

      const messageOptions = { caption: caption, mentions: [qMsg.sender] };
      const targetJid = m.sender;

      if (downloadType === "image") {
        await Hooper.sendMessage(targetJid, { image: buffer, ...messageOptions });
      } else if (downloadType === "video") {
        await Hooper.sendMessage(targetJid, { video: buffer, ...messageOptions });
      } else if (downloadType === "audio") {
        await Hooper.sendMessage(targetJid, { audio: buffer, mimetype: "audio/mp4", ptt: true });
        if (captionText) await Hooper.sendMessage(targetJid, { text: caption, mentions: messageOptions.mentions });
      } else {
        await Hooper.sendMessage(targetJid, { document: buffer, mimetype: mime || 'application/octet-stream', fileName: "stealth_media", ...messageOptions });
      }
      
      console.log(`[ STEALTH REACTION ] Successfully sent media to ${targetJid}`);

    } catch (e) {
      console.error("[ STEALTH REACTION ] Error:", e);
    }
  }
};
