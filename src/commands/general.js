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

      const menu = [
        `┌────────────────────────┐`,
        `   🤖  *SYSTEM COMMAND DASHBOARD*`,
        `└─────────────────────────`,
        ``,
        `🌐  [ PUBLIC UTILITIES ]`,
        `──────────────────────────`,
        ` ⌗ *AI & Audio* ➔ `,
        `      ${p}ai | ${p}aiimage | ${p}aisticker | ${p}voice | ${p}tts`,
        ` ⌗ *Media DL* ➔ `,
        `      ${p}dl | ${p}dlapi | ${p}mp3 | ${p}gif | ${p}image | ${p}sub`,
        ` ⌗ *Stickers* ➔ `,
        `      ${p}sticker | ${p}stickercrop | ${p}stickers | ${p}stickertext | ${p}toimage`,
        ` ⌗ *Video FX* ➔ `,
        `      ${p}avec | ${p}avm | ${p}compress | ${p}merge | ${p}reverse`,
        ` ⌗ *Utilities* ➔ `,
        `      ${p}google | ${p}search | ${p}qr | ${p}poll | ${p}remind | ${p}translate`,
        ` ⌗ *Engagement* ➔ `,
        `      ${p}8ball | ${p}fact | ${p}joke | ${p}quote | ${p}numberfact`,
        ` ⌗ *Diagnostics* ➔ `,
        `      ${p}botstatus | ${p}ping | ${p}info | ${p}aliases | ${p}warnings`,
        ` ⌗ *Session* ➔ `,
        `      ${p}cancel | ${p}done | ${p}getvar | ${p}help | ${p}menu`,
      ];

      if (adminUser) {
        menu.push(
          ``,
          `👮  [ ADMINISTRATION ]`,
          `──────────────────────────`,
          ` ⌗ *Access* ➔ `,
          `      ${p}allowgroup | ${p}removegroup | ${p}listgroups`,
          ` ⌗ *Staff* ➔ `,
          `      ${p}addadmin | ${p}removeadmin | ${p}listadmins | ${p}rejectcalls`,
          ` ⌗ *Moderation* ➔ `,
          `      ${p}add | ${p}remove | ${p}ban | ${p}unban | ${p}banlist | ${p}user`,
          ` ⌗ *Penalties* ➔ `,
          `      ${p}warn | ${p}clearwarn | ${p}setmaxwarns`,
          ` ⌗ *Core Engine* ➔ `,
          `      ${p}boton | ${p}botoff | ${p}say | ${p}broadcast | ${p}settings | ${p}setprefix`,
          ` ⌗ *AI Config* ➔ `,
          `      ${p}aion | ${p}aioff | ${p}clearai | ${p}setaiprompt`,
          ` ⌗ *Automation* ➔ `,
          `      ${p}autoreply | ${p}listautorepies | ${p}removeautoreply | ${p}replyall | ${p}stopreplyall`,
          ` ⌗ *Greetings* ➔ `,
          `      ${p}welcome | ${p}setwelcome | ${p}goodbye`,
          ` ⌗ *Scheduler* ➔ `,
          `      ${p}send | ${p}stopsend | ${p}activesends`,
          ` ⌗ *Storage* ➔ `,
          `      ${p}setvar | ${p}getvar | ${p}delvar | ${p}allvar`,
          ` ⌗ *System Logs* ➔ `,
          `      ${p}stats | ${p}exportstats | ${p}clearstats`,
          ` ⌗ *Integrations* ➔ `,
          `      ${p}setapikey | ${p}setgroqkey | ${p}settavilykey | ${p}checkapikey | ${p}setmenu`,
          ` ⌗ *Sticker Packs* ➔ `,
          `      ${p}setpackname | ${p}setpackauthor`,
          ``,
          `🛡️  [ SECURITY SHIELDS ]`,
          `──────────────────────────`,
          ` ⌗ *Anti-Link* ➔ `,
          `      ${p}antilinkon | ${p}antilinkoff | ${p}allowlink | ${p}removeallowlink | ${p}allowlinklist`,
          ` ⌗ *Anti-Delete* ➔ `,
          `      ${p}antideleteon | ${p}antideleteoff | ${p}antideletechat | ${p}antideletedm`,
          ` ⌗ *Word Filter* ➔ `,
          `      ${p}wfilteron | ${p}wfilteroff | ${p}addword | ${p}removeword | ${p}wordlist`
        );
      } else {
        menu.push(``, `_📌 Admin & Security commands hidden._`);
      }

      // Append active aliases if any exist dynamically
      const { getAllAliases } = await import("./aliases.js");
      const aliases = getAllAliases();
      if (aliases.size > 0) {
        const aliasPairs = [...aliases.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([alias, cmd]) => `${p}${alias} → ${p}${cmd}`);
        
        menu.push(
          ``,
          `⚡  [ ACTIVE MACROS ]`,
          `──────────────────────────`,
          ` ⌗ *Shortcut Keys* ➔ `,
          `      ${aliasPairs.join(" | ")}`
        );
      }

      menu.push(
        ``,
        `──────────────────────────`,
        `💡 _Tip: Send any command alone for usage instructions._`,
        `──────────────────────────`
      );

      await replyMsg(sock, from, msg, menu.join("\n"));
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
