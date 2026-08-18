import {
  banGroup,
  unbanGroup,
  checkBanGroup,
  setAntidelete,
  delAntidelete,
  checkAntidelete,
  setBotMode,
  setAllowedChat,
} from "../System/MongoDB/MongoDb_Core.js";

global.groupListMap = global.groupListMap || {};

export default {
  name: "groups",
  category: "admin",
  alias: ["groups", "mute", "allow", "antidelete", "mode"],
  uniquecommands: ["groups", "antidelete"],
  description: "Group and mode management system",
  start: async (Hooper, m, { inputCMD, text, prefix, isCreator, isAdmin }) => {
    // Determine permissions
    const canManageGroup = isCreator || (m.isGroup && isAdmin);

    if (inputCMD === "groups") {
      // Must be a direct message to the bot itself by the creator
      if (!isCreator || m.isGroup) {
         return;
      }

      const groups = await Hooper.groupFetchAllParticipating();
      const groupArray = Object.values(groups);
      
      let replyText = `🛡️ _HOOPER BOT | GROUPS_ 🛡️\n~ ───────────────────── ~\n📊 _Total Groups:_ ${groupArray.length}\n`;
      
      global.groupListMap = {}; // Reset the mapping cache
      
      for (let i = 0; i < groupArray.length; i++) {
        const group = groupArray[i];
        const jid = group.id;
        global.groupListMap[i + 1] = jid;
        
        const isBanned = await checkBanGroup(jid);
        const hasAntiDelete = await checkAntidelete(jid);
        
        replyText += `_${i + 1}. ${group.subject}_\n`;
        replyText += ` 👥 _Members:_ ${group.participants.length}\n`;
        replyText += ` 👑 _Bot Active:_ ${isBanned ? "❌" : "✔️"}\n`;
        replyText += ` 🗑️ _Antidelete:_ ${hasAntiDelete ? "✔️" : "❌"}\n`;
      }
      
      replyText += `~ ───────────────────── ~\n⚙️ _Group Management Shortcuts:_\n`;
      replyText += ` • \`.mute <number or numbers>\` — Disable bot in specific group\n`;
      replyText += ` • \`.allow <number or numbers or all>\` — Allows the bot in that specific group or groups.\n`;
      replyText += ` • \`.antidelete on or off <number or numbers or all>\``;
      
      return await Hooper.sendMessage(m.from, { text: replyText }, { quoted: m });
    }

    if (inputCMD === "mute") {
      if (!canManageGroup) return;
      if (!text && !m.isGroup) return m.reply(`Usage: ${prefix}mute <numbers>\nExample: ${prefix}mute 1 2`);
      
      let jidsToMute = [];
      if (m.isGroup && !text) {
         jidsToMute.push(m.from);
      } else {
         const numbers = text.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
         for (const num of numbers) {
           const jid = global.groupListMap[num];
           if (jid) jidsToMute.push(jid);
         }
      }
      
      if (jidsToMute.length === 0) return m.reply("No valid groups found to mute.");
      
      for (const jid of jidsToMute) {
        await banGroup(jid);
      }
      return m.reply(`✔️ Disabled bot in ${jidsToMute.length} group(s).`);
    }

    if (inputCMD === "allow") {
      if (!canManageGroup) return;
      if (!text && !m.isGroup) return m.reply(`Usage: ${prefix}allow <numbers|all>\nExample: ${prefix}allow 1 2`);
      
      let jidsToAllow = [];
      if (text.toLowerCase() === "all" && !m.isGroup) {
         jidsToAllow = Object.values(global.groupListMap);
      } else if (m.isGroup && !text) {
         jidsToAllow.push(m.from);
      } else {
         const numbers = text.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
         for (const num of numbers) {
           const jid = global.groupListMap[num];
           if (jid) jidsToAllow.push(jid);
         }
      }
      
      if (jidsToAllow.length === 0) return m.reply("No valid groups found to allow.");
      
      for (const jid of jidsToAllow) {
        await unbanGroup(jid);
        await setAllowedChat(jid); // Explicitly allow it in DB
      }
      return m.reply(`✔️ Allowed bot in ${jidsToAllow.length} group(s).`);
    }

    if (inputCMD === "antidelete") {
      if (!canManageGroup) return;
      if (!text) return m.reply(`Usage: ${prefix}antidelete <on/off> [numbers/all]`);
      
      const args = text.toLowerCase().split(/\s+/);
      const action = args[0]; // 'on' or 'off'
      if (action !== "on" && action !== "off") return m.reply(`Usage: ${prefix}antidelete <on/off> [numbers/all]`);
      
      let jidsToToggle = [];
      const targetStr = args.slice(1).join(" ").trim();
      
      if (targetStr === "all") {
         jidsToToggle = Object.values(global.groupListMap);
      } else if (targetStr) {
         const numbers = targetStr.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
         for (const num of numbers) {
           const jid = global.groupListMap[num];
           if (jid) jidsToToggle.push(jid);
         }
      } else if (m.isGroup) {
         jidsToToggle.push(m.from);
      } else {
         return m.reply("Please specify 'all' or provide group numbers.");
      }
      
      if (jidsToToggle.length === 0) return m.reply("No valid groups found to toggle antidelete.");
      
      for (const jid of jidsToToggle) {
        if (action === "on") await setAntidelete(jid);
        else await delAntidelete(jid);
      }
      
      return m.reply(`✔️ Antidelete turned ${action.toUpperCase()} for ${jidsToToggle.length} group(s).`);
    }

    if (inputCMD === "mode") {
      if (!isCreator) return;
      if (!text) return m.reply(`Usage: ${prefix}mode <public|private|self>`);
      const newMode = text.toLowerCase().trim();
      if (!["public", "private", "self"].includes(newMode)) {
        return m.reply(`Invalid mode. Use public, private, or self.`);
      }
      await setBotMode(newMode);
      return m.reply(`✔️ Bot mode successfully set to *${newMode}*.`);
    }
  }
};
