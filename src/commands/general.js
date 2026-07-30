import { botConfig } from "../config.js";
import { getSetting } from "../db.js";
import { cachedGetSetting } from "../cache.js";
import { replyMsg, isAdmin, alertOwner } from "./helpers.js";

export const generalCommands = {

  ping: {
    adminOnly: false,
    requiresArgs: false,
    description: "Check bot latency and server uptime",
    handler: async (sock, msg, _args, from) => {
      const start = Date.now();
      const sent = await replyMsg(sock, from, msg, "🏓 Pinging...");
      const latency = Date.now() - start;

      const uptimeSecs = Math.floor(process.uptime());
      const h = String(Math.floor(uptimeSecs / 3600)).padStart(2, "0");
      const m = String(Math.floor((uptimeSecs % 3600) / 60)).padStart(2, "0");
      const s = String(uptimeSecs % 60).padStart(2, "0");

      const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

      await replyMsg(sock, from, msg,
        `🏓 *Pong!*

` +
        `⚡ *Latency:* ${latency}ms
` +
        `⏱️ *Uptime:* ${h}:${m}:${s}
` +
        `🧠 *Memory:* ${memMB} MB
` +
        `📅 *Since:* ${new Date(Date.now() - uptimeSecs * 1000).toLocaleString()}`
      );
    },
  },

  help: {
    adminOnly: false,
    requiresArgs: false,
    description: "Show the full command menu",
    handler: async (sock, msg, _args, from, prefix) => {
      const p = prefix;
      const adminUser = isAdmin(msg);

      const menu = `╭━━〔 🧠 AI & CREATION 〕━━╮
│ ${p}ai
│ ${p}aiimage
│ ${p}aisticker
│ ${p}voice
└ ${p}tts

╭━━〔 📥 MEDIA CENTER 〕━━╮
----🌍 Download Tools
│ ${p}dl
│ ${p}dlapi
│ ${p}mp3
│ ${p}gif
│ ${p}image
│ ${p}spotify
└ ${p}sub

╭━━〔 🎨 STICKER STUDIO 〕━━╮
----🖼 Creative Tools
│ ${p}sticker
│ ${p}stickercrop
│ ${p}stickers
│ ${p}stickertext
│ ${p}triggered
│ ${p}wasted
└ ${p}toimage

╭━━〔 🎬 VIDEO ENGINE 〕━━╮
----🎞 Processing Tools
│ ${p}avec
│ ${p}avm
│ ${p}compress
│ ${p}merge
└ ${p}reverse

╭━━〔 🛠 UTILITY HUB 〕━━╮
----⚙ Everyday Tools
│ ${p}google
│ ${p}search
│ ${p}qr
│ ${p}pdf
│ ${p}poll
│ ${p}remind
│ ${p}lyrics
└ ${p}translate

╭━━〔 🎮 FUN & ENGAGEMENT 〕━━╮
----🎲 Entertainment
│ ${p}8ball
│ ${p}fact
│ ${p}joke
│ ${p}meme
│ ${p}quote
└ ${p}numberfact

╭━━〔 📊 SYSTEM MONITOR 〕━━╮
----🖥 Diagnostics
│ ${p}botstatus
│ ${p}ping
│ ${p}info
│ ${p}aliases
└ ${p}warnings

╭━━〔 🔄 SESSION CONTROL 〕━━╮
----🔐 Session Tools
│ ${p}cancel
│ ${p}done
│ ${p}getvar
│ ${p}help
└ ${p}menu

╭━━〔 ⚡ ACTIVE MACROS 〕━━╮
----🚀 Shortcuts

│ ${p}admins
└──→ ${p}listadmins

│ ${p}antidelete
└──→ ${p}antideleteon

│ ${p}ask
└──→ ${p}ai

│ ${p}botoff
└──→ ${p}all

│ ${p}img
└──→ ${p}image

│ ${p}movie
└──→ ${p}imdb

│ ${p}st
└──→ ${p}sticker

│ ${p}vo
└──→ ${p}viewonce

╭━━〔 🔒 RESTRICTED AREA 〕━━╮
----⚠ Hidden Modules

│ 👑 Owner Commands
│ 🛡 Admin Controls
│ 🔐 Security System
│ ⚙ Developer Tools

╭━━〔 💡 QUICK GUIDE 〕━━╮
Send any command alone to view:
✓ Usage
✓ Examples
✓ Parameters
✓ Aliases

╰━━━〔 🤖 BOT CORE 〕━━━╯`;

      if (adminUser) {
        // Append actual admin commands if the user is an admin
        const adminMenu = `\n\n╭━━〔 👮 ADMIN CONTROLS 〕━━╮
│ ${p}addadmin
│ ${p}removeadmin
│ ${p}ban
│ ${p}unban
│ ${p}warn
│ ${p}clearwarn
│ ${p}setmaxwarns
│ ${p}settings
│ ${p}setprefix
│ ${p}setapikey
│ ${p}setgroqkey
└ ${p}setpackname

╭━━〔 🛡️ SECURITY SHIELDS 〕━━╮
│ ${p}antilinkon
│ ${p}antilinkoff
│ ${p}antideleteon
│ ${p}antideleteoff
│ ${p}wfilteron
└ ${p}wfilteroff`;
        await replyMsg(sock, from, msg, menu + adminMenu);
        return;
      }
      
      await replyMsg(sock, from, msg, menu);
    },
  },

  menu: {
    adminOnly: false,
    requiresArgs: false,
    description: "Show the full command menu",
    handler: async (sock, msg, args, from, prefix) => {
      // Alias menu to help
      return generalCommands.help.handler(sock, msg, args, from, prefix);
    }
  },

  botstatus: {
    adminOnly: false,
    requiresArgs: false,
    description: "Show bot status and uptime",
    handler: async (sock, msg, _args, from, prefix) => {
      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = Math.floor(uptime % 60);

      const activeGlobal = cachedGetSetting("bot_active", "true");
      const activeLocal = cachedGetSetting(`bot_active_${from}`, "true");

      let statusText = "🔴 Inactive";
      if (activeGlobal === "true" && activeLocal !== "false") {
        statusText = "✅ Online (Active in this chat)";
      } else if (activeGlobal === "true" && activeLocal === "false") {
        statusText = "🔴 Inactive in this chat (Online globally)";
      } else if (activeGlobal !== "true") {
        statusText = "🔴 Inactive globally";
      }

      await replyMsg(sock, from, msg,
        `*🤖 Bot Status*\n\n` +
        `${statusText}\n` +
        `📱 Number: ${botConfig.BOT_NUMBER}\n` +
        `⏱️ Uptime: ${h}h ${m}m ${s}s\n` +
        `🔧 Prefix: ${prefix}`
      );
    },
  },

  say: {
    adminOnly: true,
    requiresArgs: true,
    description: "Send a message as the bot",
    usage: "!say <message>",
    examples: ["!say Hello everyone!"],
    notes: "The message will be sent without showing it came from you.",
    handler: async (sock, msg, args, from) => {
      await sock.sendMessage(from, { text: args.join(" ") });
    },
  },

};
