import { getSetting, setSetting } from "../src/db.js";

export default {
  name: "status",
  category: "admin",
  uniquecommands: ["status", "auto"],
  description: "WhatsApp Status Saver & Auto-Forwarder",
  start: async (Hooper, m, { inputCMD, text, prefix, isCreator, mentionByTag, args }) => {
    if (!isCreator) return;

    if (inputCMD === "status") {
      if (!text) return m.reply(`Usage: ${prefix}status @user or ${prefix}status <number>`);
      
      let targetJid = "";
      if (mentionByTag && mentionByTag.length > 0) {
         targetJid = mentionByTag[0];
      } else {
         const cleanedNumber = text.replace(/[^0-9]/g, "");
         if (cleanedNumber) targetJid = cleanedNumber + (cleanedNumber.length > 15 ? "@g.us" : "@s.whatsapp.net");
      }
      
      if (!targetJid || !targetJid.endsWith("@s.whatsapp.net")) {
         return m.reply(`Please provide a valid user number or tag.`);
      }

      // Read from the global store cache
      const store = Hooper.store; 
      if (!store || !store.messages["status@broadcast"]) {
        return m.reply("No statuses have been cached yet. Make sure I have been running and receiving statuses.");
      }
      
      const allStatuses = Object.values(store.messages["status@broadcast"]);
      const userStatuses = allStatuses.filter(msg => msg.key?.participant === targetJid);
      
      if (userStatuses.length === 0) {
        return m.reply(`No recent statuses found for @${targetJid.split("@")[0]} in my cache.`, { mentions: [targetJid] });
      }
      
      m.reply(`Found ${userStatuses.length} recent status(es) from @${targetJid.split("@")[0]}. Forwarding them to you now...`, { mentions: [targetJid] });
      
      const { downloadContentFromMessage, getContentType } = await import("@whiskeysockets/baileys");
      
      for (const msg of userStatuses) {
        if (!msg.message) continue;
        const contentType = getContentType(msg.message);
        const mediaMsg = msg.message[contentType];
        
        let downloadType = "image";
        if (contentType.includes("video")) downloadType = "video";
        if (contentType.includes("audio")) downloadType = "audio";
        
        if (["imageMessage", "videoMessage", "audioMessage", "extendedTextMessage"].includes(contentType)) {
           // Standard forwarding
           await Hooper.sendMessage(m.sender, { forward: msg });
        } else {
           // Fallback if forward doesn't work well
           try {
             await Hooper.sendMessage(m.sender, { forward: msg });
           } catch(e) {}
        }
        await new Promise(r => setTimeout(r, 1000)); // anti-spam delay
      }
      return;
    }

    if (inputCMD === "auto") {
      if (!args[0] || args[0].toLowerCase() !== "status") return m.reply(`Usage: ${prefix}auto status @user`);
      if (!args[1]) return m.reply(`Please mention a user or provide a number. Usage: ${prefix}auto status @user`);
      
      let targetJid = "";
      if (mentionByTag && mentionByTag.length > 0) {
         targetJid = mentionByTag[0];
      } else {
         const textTarget = args.slice(1).join("");
         const cleanedNumber = textTarget.replace(/[^0-9]/g, "");
         if (cleanedNumber) targetJid = cleanedNumber + (cleanedNumber.length > 15 ? "@g.us" : "@s.whatsapp.net");
      }
      
      if (!targetJid || !targetJid.endsWith("@s.whatsapp.net")) {
         return m.reply(`Please provide a valid user number or tag.`);
      }

      let targetsStr = await getSetting("auto_status_targets", "");
      let targets = targetsStr ? targetsStr.split(",") : [];
      
      let enabled = false;
      if (targets.includes(targetJid)) {
         targets = targets.filter(j => j !== targetJid);
      } else {
         targets.push(targetJid);
         enabled = true;
      }
      
      await setSetting("auto_status_targets", targets.join(","));
      
      return m.reply(`🔄 *Auto-Status Forwarding for @${targetJid.split("@")[0]}: ${enabled ? "ON" : "OFF"}*\n\n${enabled ? "Whenever this user posts a new status, I will automatically download and forward it to your DM." : "Auto-Status Forwarding disabled for this user."}`, { mentions: [targetJid] });
    }
  }
};
