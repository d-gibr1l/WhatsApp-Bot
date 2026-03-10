import { BOT_NUMBER } from "../config.js";
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
        `╭━━━━━━━━━━━━━━━━━━━━━━╮`,
        `┃   🤖 *BOT COMMAND MENU*   ┃`,
        `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
        ``,
        `🎮 *INTERACTIVE & MEDIA*`,
        `┌─────────────────────────`,
        `│ ${p}ai          → Chat with AI`,
        `│ ${p}clearai     → Clear AI history`,
        `│ ${p}aion/off    → Toggle AI`,
        `│ ${p}dl          → Download media`,
        `│ ${p}dlon/off    → Toggle downloader`,
        `│ ${p}sticker     → Make a sticker`,
        `│ ${p}translate   → Translate text`,
        `│ ${p}quote       → Random quote`,
        `│ ${p}fact        → Random fun fact`,
        `│ ${p}8ball       → Magic 8-ball`,
        `└─────────────────────────`,
        ``,
        `🛠️ *UTILITY*`,
        `┌─────────────────────────`,
        `│ ${p}ping        → Check bot status`,
        `│ ${p}botstatus   → Uptime & info`,
        `│ ${p}say         → Speak as bot`,
        `│ ${p}remind      → Set a reminder`,
        `│ ${p}menu        → Show custom menu`,
        `│ ${p}stats       → Message stats`,
        `│ ${p}user        → User lookup`,
        `└─────────────────────────`,
      ];

      if (adminUser) {
        menu.push(
          ``,
          `👮 *MODERATION*`,
          `┌─────────────────────────`,
          `│ ${p}warn        → Warn a user`,
          `│ ${p}warnings    → Check warnings`,
          `│ ${p}clearwarn   → Reset warnings`,
          `│ ${p}ban/unban   → Ban control`,
          `│ ${p}banlist     → List banned`,
          `│ ${p}add/remove  → Group members`,
          `└─────────────────────────`,
          ``,
          `⚙️ *SETTINGS*`,
          `┌─────────────────────────`,
          `│ ${p}boton/off      → Toggle bot`,
          `│ ${p}addadmin       → Add admin`,
          `│ ${p}removeadmin    → Remove admin`,
          `│ ${p}listadmins     → List admins`,
          `│ ${p}setprefix      → Change prefix`,
          `│ ${p}setwelcome     → Welcome msg`,
          `│ ${p}settings       → View settings`,
          `│ ${p}broadcast      → Mass message`,
          `│ ${p}setapikey      → RapidAPI key`,
          `│ ${p}setgroqkey     → Groq AI key`,
          `│ ${p}setaiprompt    → AI personality`,
          `│ ${p}exportstats    → Export CSV`,
          `│ ${p}clearstats     → Wipe logs`,
          `└─────────────────────────`,
          ``,
          `🔤 *FILTERS & AUTO-REPLY*`,
          `┌─────────────────────────`,
          `│ ${p}autoreply       → Add reply`,
          `│ ${p}removeautoreply → Remove reply`,
          `│ ${p}listautorepies  → List replies`,
          `│ ${p}addword         → Filter word`,
          `│ ${p}removeword      → Remove word`,
          `│ ${p}wordlist        → List words`,
          `│ ${p}wfilteron/off   → Toggle filter`,
          `└─────────────────────────`,
        );
      }

      menu.push(``, `_📌 Admin commands only visible to admins._`);
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
      const active = cachedGetSetting("bot_active", "true");
      await replyMsg(sock, from, msg,
        `*🤖 Bot Status*\n\n` +
        `${active === "true" ? "✅ Online" : "🔴 Inactive"}\n` +
        `📱 Number: ${BOT_NUMBER}\n` +
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
