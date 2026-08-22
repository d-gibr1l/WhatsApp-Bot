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

      const { getAllGroups, getBotMode } = await import("../src/db.js");
      const dbGroups = await getAllGroups();
      const botMode = await getBotMode();
      
      let replyText = `🌟 _HOOPER BOT | GROUPS_ 🌟\n~ ────────── ~\n📂 _Total Groups:_ ${dbGroups.length}\n`;
      
      global.groupListMap = {}; // Reset the mapping cache
      
      for (let i = 0; i < dbGroups.length; i++) {
        const group = dbGroups[i];
        const jid = group.id;
        global.groupListMap[i + 1] = jid;
        
        let isActive = !group.bangroup;
        if ((botMode === "private" || botMode === "self") && !group.allowed) {
            isActive = false;
        }
        
        replyText += `_${i + 1}. ${group.name || jid}_\n`;
        replyText += ` 🤖 _Bot Active:_ ${isActive ? "✅" : "❌"}\n`;
        replyText += ` 🗑️ _Antidelete:_ ${group.antidelete ? "✅" : "❌"}\n`;
      }
      
      replyText += `~ ───────────────────── ~\n⚙️ _Group Management Shortcuts:_\n`;
      replyText += ` • \`.mute <number or numbers>\` — Disable bot in specific group\n`;
      replyText += ` • \`.allow <number or numbers or all>\` — Allows the bot in that specific group or groups.\n`;
      replyText += ` • \`.antidelete on or off <number or numbers or all>\``;
      
      return await Hooper.sendMessage(m.from, { text: replyText }, { quoted: m });
    }

    if (inputCMD === "mute") {
      if (!canManageGroup) return;
      
      let jidsToMute = [];
      if (!text) {
         jidsToMute.push(m.from);
      } else {
         const { getAllGroups } = await import("../src/db.js");
         const dbGroups = await getAllGroups();
         const numbers = text.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
         for (const num of numbers) {
           const idx = parseInt(num) - 1;
           if (dbGroups[idx]) jidsToMute.push(dbGroups[idx].id);
         }
      }
      
      if (jidsToMute.length === 0) return m.reply("No valid groups/chats found to mute.");
      
      for (const jid of jidsToMute) {
        await banGroup(jid);
      }
      return m.reply(`✔️ Disabled bot in ${jidsToMute.length} chat(s).`);
    }

    if (inputCMD === "allow") {
      if (!canManageGroup) return;
      
      let jidsToAllow = [];
      if (!text) {
         jidsToAllow.push(m.from);
      } else if (text.toLowerCase() === "all") {
         const { getAllGroups } = await import("../src/db.js");
         const dbGroups = await getAllGroups();
         jidsToAllow = dbGroups.map(g => g.id);
      } else {
         const { getAllGroups } = await import("../src/db.js");
         const dbGroups = await getAllGroups();
         const numbers = text.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
         for (const num of numbers) {
           const idx = parseInt(num) - 1;
           if (dbGroups[idx]) jidsToAllow.push(dbGroups[idx].id);
         }
      }
      
      if (jidsToAllow.length === 0) return m.reply("No valid groups/chats found to allow.");
      
      for (const jid of jidsToAllow) {
        await unbanGroup(jid);
        await setAllowedChat(jid); // Explicitly allow it in DB
      }
      return m.reply(`✔️ Allowed bot in ${jidsToAllow.length} chat(s).`);
    }

    if (inputCMD === "antidelete") {
      if (!canManageGroup) return;
      if (!text) return m.reply(`Usage: ${prefix}antidelete <on/off> [numbers/all]`);
      
      const args = text.toLowerCase().split(/\s+/);
      const action = args[0]; // 'on' or 'off'
      if (action !== "on" && action !== "off") return m.reply(`Usage: ${prefix}antidelete <on/off> [numbers/all]`);
      
      let jidsToToggle = [];
      const targetStr = args.slice(1).join(" ").trim();
      
      if (!targetStr) {
         jidsToToggle.push(m.from);
      } else if (targetStr === "all") {
         const { getAllGroups } = await import("../src/db.js");
         const dbGroups = await getAllGroups();
         jidsToToggle = dbGroups.map(g => g.id);
      } else {
         const { getAllGroups } = await import("../src/db.js");
         const dbGroups = await getAllGroups();
         const numbers = targetStr.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
         for (const num of numbers) {
           const idx = parseInt(num) - 1;
           if (dbGroups[idx]) jidsToToggle.push(dbGroups[idx].id);
         }
      }
      
      if (jidsToToggle.length === 0) return m.reply("No valid groups/chats found to toggle antidelete.");
      
      for (const jid of jidsToToggle) {
        if (action === "on") await setAntidelete(jid);
        else await delAntidelete(jid);
      }
      
      return m.reply(`✔️ Antidelete turned ${action.toUpperCase()} for ${jidsToToggle.length} chat(s).`);
    }

    if (inputCMD === "mode") {
      if (!isCreator) return;
      const { getBotMode } = await import("../src/db.js");
      const currentMode = await getBotMode();

      if (!text || !["public", "private", "self"].includes(text.toLowerCase().trim())) {
        let helpText = `⚙️ *Bot Mode Configuration*\n\n`;
        helpText += `*Current Mode:* \`${currentMode.toUpperCase()}\`\n\n`;
        helpText += `*Available Modes:*\n`;
        helpText += `🌎 *Public* - The bot replies to everyone in all groups and private chats.\n`;
        helpText += `🔒 *Private* - The bot ignores all groups unless explicitly allowed via \`.allow\`. It still replies to private DMs.\n`;
        helpText += `👤 *Self* - The bot completely ignores everyone except you (the owner) in all chats, unless explicitly allowed.\n\n`;
        helpText += `*Usage:* \`${prefix}mode < public, private, self >\``;
        return m.reply(helpText);
      }
      
      const newMode = text.toLowerCase().trim();
      await setBotMode(newMode);
      return m.reply(`✔️ Bot mode successfully changed from *${currentMode}* to *${newMode}*.`);
    }
  }
};
