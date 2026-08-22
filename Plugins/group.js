import fs from "fs";
import moment from "moment-timezone";
import {
  setWelcome,
  checkWelcome,
  delWelcome,
  setAntilink,
  checkAntilink,
  delAntilink,
  setGroupChatbot,
  checkGroupChatbot,
  delGroupChatbot,
  setAntidelete,
  checkAntidelete,
  delAntidelete,
  checkMod,
} from "../System/MongoDB/MongoDb_Core.js";

const mergedCommands = [
  "antilink",
  "welcome",
  "demote",
  "gclink",
  "grouplink",
  "group",
  "gc",
  "htag",
  "promote",
  "remove",
  "revoke",
  "chatbotgc",
  "antidel",
  "antidelete",
];

export default {
  name: "groupanagement",
  alias: [...mergedCommands],
  uniquecommands: [
    "demote",
    "gclink",
    "antilink",
    "welcome",
    "group",
    "promote",
    "remove",
    "revoke",
    "chatbotgc",
    "antidel",
  ],
  description: "All Group Management Commands",
  start: async (
    Hooper,
    m,
    {
      inputCMD,
      text,
      prefix,
      doReact,
      args,
      itsMe,
      participants,
      metadata,
      mentionByTag,
      mime,
      isMedia,
      quoted,
      botNumber,
      botLid,
      isBotAdmin,
      groupAdmin,
      isAdmin,
    },
  ) => {
    const messageSender = m.sender;
    const quotedsender = m.quoted ? m.quoted.sender : mentionByTag[0];
    // Helper: check if a JID belongs to the bot (handles phone JID, LID, or any format)
    const isBotJid = (jid) => {
      if (!jid) return false;
      if (jid === botNumber || jid === botLid) return true;
      // Also check via the LID<->JID map
      const mapped = global.lidToJidMap?.get(jid);
      if (mapped && (mapped === botNumber || mapped === botLid)) return true;
      return false;
    };
    switch (inputCMD) {

      case "demote": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        if (!text && !m.quoted) {
          await doReact("❔");
          return m.reply(`Please tag a user or reply to their message to *Demote* !`);
        }
        if (quotedsender && quotedsender === m.sender) {
          await doReact("❌");
          return m.reply(`You can't demote yourself !`);
        }
        if (isBotJid(quotedsender)) {
          await doReact("❌");
          return m.reply(`Sorry, I can't demote myself !`);
        }
        const mentionedUser = m.quoted ? m.quoted.sender : mentionByTag[0];
        const userId = mentionedUser || m.msg.contextInfo.participant;
        if (!groupAdmin.includes(userId)) {
          return Hooper.sendMessage(
            m.from,
            {
              text: `@${mentionedUser.split("@")[0]} Senpai is not an *Admin* of this group!`,
              mentions: [mentionedUser],
            },
            { quoted: m },
          );
        }
        // Cannot demote the bot itself (second check after userId is resolved)
        if (isBotJid(userId)) {
          await doReact("❌");
          return m.reply(`Sorry, I can't demote myself !`);
        }
        // Cannot demote the group creator
        if (metadata.owner && (userId === metadata.owner || userId.replace(/[^0-9]/g, "") === metadata.owner.replace(/[^0-9]/g, ""))) {
          await doReact("❌");
          return m.reply(`*Command Rejected !* You cannot demote the *Group Creator* !`);
        }
        await doReact("📉");
        try {
          await Hooper.groupParticipantsUpdate(m.from, [userId], "demote");
          await Hooper.sendMessage(
            m.from,
            {
              text: `Sorry @${mentionedUser.split("@")[0]} Senpai, you have been *Demoted* by @${messageSender.split("@")[0]} !`,
              mentions: [mentionedUser, messageSender],
            },
            { quoted: m },
          );
        } catch (error) {
          await doReact("❌");
          await Hooper.sendMessage(
            m.from,
            {
              text: `An error occured while trying to demote @${mentionedUser.split("@")[0]} Senpai !\n\n*Error:* ${error}`,
              mentions: [mentionedUser],
            },
            { quoted: m },
          );
        }
        break;
      }

      case "gclink":
      case "grouplink": {
        if (!m.isGroup) {
          await doReact("❌");
          return m.reply(`*This command can only be used in groups!*`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        await doReact("🧩");
        
        let link;
        try {
          link = await Hooper.groupInviteCode(m.from);
        } catch (err) {
          return m.reply(`*Error:* Failed to generate group link. Ensure the bot is an admin and the link hasn't been recently reset.\n\n_Details: ${err.message}_`);
        }
        
        const linkcode = `https://chat.whatsapp.com/${link}`;
        let ppgc;
        let isLocal = false;
        try {
          ppgc = await Hooper.profilePictureUrl(m.from, "image");
        } catch {
          ppgc = "./Assets/gclink.png";
          isLocal = true;
        }
        try {
          await Hooper.sendMessage(
            m.from,
            {
              image: isLocal ? fs.readFileSync(ppgc) : { url: ppgc },
              caption: `\n_🎀 Group Name:_ *${metadata.subject || "Unknown"}*\n\n_🧩 Group Link:_\n${linkcode}\n`,
            },
            { quoted: m },
          );
        } catch (err) {
          await Hooper.sendMessage(
            m.from,
            { text: `Failed to fetch group link: ${err.message}` },
            { quoted: m },
          );
        }
        break;
      }

      case "group":
      case "gc": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        await doReact("⚜️");
        if (text === "close") {
          await Hooper.groupSettingUpdate(m.from, "announcement");
          await m.reply(`Group has been closed!`);
        } else if (text === "open") {
          await Hooper.groupSettingUpdate(m.from, "not_announcement");
          await m.reply(`Group has been opened!`);
        } else {
          await Hooper.sendMessage(
            m.from,
            {
              image: { url: botImage2 },
              caption: `\n*「 Group Message Settings 」*\n\nSelect an option below.\n\n*_Usage:_*\n\n*${prefix}group open*\n*${prefix}group close*\n`,
            },
            { quoted: m },
          );
        }
        break;
      }


      case:
      case "htag": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        let message2;
        if (!isMedia) {
          if (m.quoted) {
            message2 = m.quoted.msg || "『 *Attention Everybody* 』";
          } else if (args.length) {
            message2 = `『 *Attention Everybody* 』\n\n*🎀 Message:* ${args.join(" ")}`;
          } else {
            message2 = "『 *Attention Everybody* 』";
          }
        } else {
          const caption = m.quoted?.msg?.caption || m.msg?.caption || (args.length ? args.join(" ") : "");
          message2 = caption
            ? `『 *Attention Everybody* 』\n\n*🎀 Message:* ${caption}`
            : "『 *Attention Everybody* 』\n\n*🎀 Message:* Check this Out !";
        }
        await doReact("🎌");
        Hooper.sendMessage(
          m.from,
          { text: message2, mentions: participants.map((a) => a.id) },
          { quoted: m },
        );
        break;
      }



      case "promote": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        if (!text && !m.quoted) {
          await doReact("❔");
          return m.reply(`Please tag a user or reply to their message to *Promote* !`);
        }
        if (quotedsender && quotedsender === m.sender) {
          await doReact("❌");
          return m.reply(`You are already an *Admin* of this group!`);
        }
        if (isBotJid(quotedsender)) {
          await doReact("❌");
          return m.reply(`I am already an *Admin* of this group!`);
        }
        const mentionedUser = m.quoted ? m.quoted.sender : mentionByTag[0];
        const userId = mentionedUser || m.msg.contextInfo.participant;
        if (groupAdmin.includes(userId)) {
          return Hooper.sendMessage(
            m.from,
            {
              text: `@${mentionedUser.split("@")[0]} Senpai is already an *Admin* of this group!`,
              mentions: [mentionedUser],
            },
            { quoted: m },
          );
        }
        await doReact("💹");
        try {
          await Hooper.groupParticipantsUpdate(m.from, [userId], "promote");
          await Hooper.sendMessage(
            m.from,
            {
              text: `Congratulations @${mentionedUser.split("@")[0]} Senpai 🥳, you have been *Promoted* by @${messageSender.split("@")[0]} !`,
              mentions: [mentionedUser, messageSender],
            },
            { quoted: m },
          );
        } catch (error) {
          await Hooper.sendMessage(
            m.from,
            {
              text: `An error occured while trying to promote @${mentionedUser.split("@")[0]} Senpai !\n\n*Error:* ${error}`,
              mentions: [mentionedUser],
            },
            { quoted: m },
          );
        }
        break;
      }

      case "remove": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        if (!text && !m.quoted) {
          await doReact("❔");
          return Hooper.sendMessage(
            m.from,
            { text: `Please tag a user or reply to their message to *Remove* !` },
            { quoted: m },
          );
        }
        if (quotedsender && quotedsender === m.sender) {
          await doReact("❌");
          return m.reply(`You cannot *Remove* yourself from this group !`);
        }
        if (isBotJid(quotedsender)) {
          await doReact("❌");
          return m.reply(`I cannot *Remove* myself from this group !`);
        }
        const mentionedUser = m.quoted ? m.quoted.sender : mentionByTag[0];
        const users = mentionedUser || m.msg.contextInfo.participant;
        await doReact("⛔");
        // Cannot remove the group creator
        if (metadata.owner && (users === metadata.owner || users.replace(/[^0-9]/g, "") === metadata.owner.replace(/[^0-9]/g, ""))) {
          await doReact("❌");
          return m.reply(`*Command Rejected !* You cannot remove the *Group Creator* !`);
        }
        // Cannot remove bot owners
        const ownerDigits = (global.owner || []).map((o) => o.replace(/[^0-9]/g, ""));
        if (ownerDigits.includes(users.replace(/[^0-9]/g, ""))) {
          await doReact("❌");
          return m.reply(`*Command Rejected !* You cannot remove a *Bot Owner* !`);
        }
        if (groupAdmin.includes(users)) {
          return Hooper.sendMessage(
            m.from,
            {
              text: `*Command Rejected !* @${mentionedUser.split("@")[0]} Senpai is an *Admin* of this group so you are not allowed to remove him !`,
              mentions: [mentionedUser],
            },
            { quoted: m },
          );
        }
        try {
          await Hooper.groupParticipantsUpdate(m.from, [users], "remove");
          await Hooper.sendMessage(
            m.from,
            {
              text: `@${mentionedUser.split("@")[0]} has been *Removed* Successfully from *${metadata.subject}*`,
              mentions: [mentionedUser],
            },
            { quoted: m },
          );
        } catch (err) {
          await m.reply(`Failed to remove user: ${err.message}`);
        }
        break;
      }



      case "revoke": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        if (m.from == "120363040838753957@g.us") {
          await doReact("❌");
          return m.reply(
            "Sorry, this command is not allowed in *Hooper Support Group* !\n\nYou are not allowed to change support group link !",
          );
        }
        await doReact("💫");
        try {
          await Hooper.groupRevokeInvite(m.from);
          await Hooper.sendMessage(
            m.from,
            { text: `Group link has been *Updated* Successfully!` },
            { quoted: m },
          );
        } catch (err) {
          await m.reply(`Failed to revoke link: ${err.message}`);
        }
        break;
      }



      case "chatbotgc": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}chatbotgc on`,
          );
        }
        const chatbotGCStatus = await checkGroupChatbot(m.from);
        if (args[0] == "on") {
          if (chatbotGCStatus) {
            await doReact("❌");
            return m.reply(`*Group Chatbot* is already *Enabled* !`);
          }
          await doReact("🧩");
          await setGroupChatbot(m.from);
          await m.reply(
            `*Group Chatbot* has been *Enabled* Successfully ! \n\nBot will not reply to messages where bot is mentioned!`,
          );
        } else if (args[0] == "off") {
          if (!chatbotGCStatus) {
            await doReact("❌");
            return m.reply(`*Group Chatbot* is already *Disabled* !`);
          }
          await doReact("🧩");
          await delGroupChatbot(m.from);
          await m.reply(`*Group Chatbot* has been *Disabled* Successfully !`);
        } else {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}chatbotgc on`,
          );
        }
        break;
      }

      case "antilink": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}antilink on`,
          );
        }
        const antilinkStatus = await checkAntilink(m.from);
        if (args[0] == "on") {
          if (antilinkStatus) {
            await doReact("❌");
            return m.reply(`*Antilink* is already *Enabled* !`);
          }
          await doReact("⚜️");
          await setAntilink(m.from);
          await m.reply(
            `*Antilink* has been *Enabled* Successfully ! \n\nBot will remove all links from messages!`,
          );
        } else if (args[0] == "off") {
          if (!antilinkStatus) {
            await doReact("❌");
            return m.reply(`*Antilink* is already *Disabled* !`);
          }
          await doReact("⚜️");
          await delAntilink(m.from);
          await m.reply(`*Antilink* has been *Disabled* Successfully !`);
        } else {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}antilink on`,
          );
        }
        break;
      }

      case "welcome": {
        if (!isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!isBotAdmin) {
          await doReact("❌");
          return m.reply(`*Bot* must be *Admin* in order to use this Command!`);
        }
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}welcome on`,
          );
        }
        const welcomeStatus = await checkWelcome(m.from);
        if (args[0] == "on") {
          if (welcomeStatus) {
            await doReact("❌");
            return m.reply(`*Welcome* is already *Enabled* !`);
          }
          await doReact("🎀");
          await setWelcome(m.from);
          await m.reply(
            `*Welcome/Goodbye* messages are *Enabled* Successfully !`,
          );
        } else if (args[0] == "off") {
          if (!welcomeStatus) {
            await doReact("❌");
            return m.reply(`*Welcome* is already *Disabled* !`);
          }
          await doReact("🎀");
          await delWelcome(m.from);
          await m.reply(
            `*Welcome/Goodbye* messages are *Disabled* Successfully !`,
          );
        } else {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}welcome on`,
          );
        }
        break;
      }

      case "antidel":
      case "antidelete": {
        if (m.from.endsWith("@g.us") && !isAdmin) {
          await doReact("❌");
          return m.reply(`*You* must be *Admin* in order to use this Command!`);
        }
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}antidelete on`,
          );
        }
        const antidelStatus = await checkAntidelete(m.from);
        const action = args[0]?.toLowerCase();
        
        if (action == "on") {
          if (antidelStatus) {
            await doReact("❌");
            return m.reply(`*Anti-Delete* is already *Enabled* !`);
          }
          await doReact("🛡️");
          await setAntidelete(m.from);
          await m.reply(
            `*Anti-Delete* has been *Enabled* Successfully !\n\nDeleted messages will be resent by the bot.`,
          );
        } else if (action == "off") {
          if (!antidelStatus) {
            await doReact("❌");
            return m.reply(`*Anti-Delete* is already *Disabled* !`);
          }
          await doReact("🛡️");
          await delAntidelete(m.from);
          await m.reply(`*Anti-Delete* has been *Disabled* Successfully !`);
        } else {
          await doReact("❔");
          return m.reply(
            `Please provide On / Off action !\n\n*Example:*\n\n${prefix}antidelete on`,
          );
        }
        break;
      }

      default:
        break;
    }
  },
};
