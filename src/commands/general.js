import { botConfig } from "../config.js";
import { cachedGetSetting } from "../cache.js";
import { replyMsg, isAdmin } from "./helpers.js";

export const generalCommands = {

  ping: {
    adminOnly: false,
    requiresArgs: false,
    description: "Check bot latency and server uptime",
    handler: async (sock, msg, _args, from) => {
      const start = Date.now();
      await replyMsg(sock, from, msg, "🏓 Pinging...");
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

      let userMenu = `╭━━〔 🤖 BOT CORE 〕━━╮\n`;
      let adminMenu = `\n╭━━〔 👮 ADMIN CONTROLS 〕━━╮\n`;

      // Sort commands alphabetically for better UX
      const { commands } = await import("./registry.js");
      const cmdList = Object.entries(commands).sort((a, b) => a[0].localeCompare(b[0]));

      for (const [cmdName, cmdInfo] of cmdList) {
        if (cmdInfo.adminOnly) {
          adminMenu += `│ ${p}${cmdName}\n`;
        } else {
          userMenu += `│ ${p}${cmdName}\n`;
        }
      }

      userMenu += `╰━━━━━━━━━━━━━━━━━━━━╯\n`;
      adminMenu += `╰━━━━━━━━━━━━━━━━━━━━╯\n`;
      
      userMenu += `\n╭━━〔 💡 QUICK GUIDE 〕━━╮\nSend any command alone to view usage!`;

      if (adminUser) {
        await replyMsg(sock, from, msg, userMenu + adminMenu);
        return;
      }
      
      await replyMsg(sock, from, msg, userMenu);
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
