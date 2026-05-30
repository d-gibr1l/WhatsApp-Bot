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

      const { commands } = await import("./registry.js");

      const menu = [
        `╭━━━━━━━━━━━━━━━━━━━━━━╮`,
        `┃   🤖 *BOT COMMAND MENU*   ┃`,
        `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
        ``,
      ];

      const publicCmds = [];
      const adminCmds = [];

      for (const [cmdName, cmd] of Object.entries(commands)) {
        const line = `│ ${p}${cmdName.padEnd(14)} → ${cmd.description || "No description"}`;
        if (cmd.adminOnly) adminCmds.push(line);
        else publicCmds.push(line);
      }

      menu.push(`🌐 *PUBLIC COMMANDS*`);
      menu.push(`┌─────────────────────────`);
      menu.push(...publicCmds.sort());
      menu.push(`└─────────────────────────`);
      menu.push(``);

      if (adminUser && adminCmds.length > 0) {
        menu.push(`👮 *ADMIN COMMANDS*`);
        menu.push(`┌─────────────────────────`);
        menu.push(...adminCmds.sort());
        menu.push(`└─────────────────────────`);
        menu.push(``);
      }

      menu.push(`_💡 Type any command alone for usage & examples_`);

      // Append active aliases if any exist
      const { getAllAliases } = await import("./aliases.js");
      const aliases = getAllAliases();
      if (aliases.size > 0) {
        const aliasLines = [...aliases.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([alias, cmd]) => `│ ${p}${alias.padEnd(14)} → ${p}${cmd}`);
        menu.push(
          ``,
          `⚡ *YOUR ACTIVE ALIASES*`,
          `┌─────────────────────────`,
          ...aliasLines,
          `└─────────────────────────`,
        );
      }

      if (!adminUser) {
        menu.push(``, `_📌 Admin commands hidden._`);
      }

      await replyMsg(sock, from, msg, menu.join("\n"));
    },
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
