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
        `╭━━━━━━━━━━━━━━━━━━━━━━╮`,
        `┃   🤖 *BOT COMMAND MENU*   ┃`,
        `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
        ``,
        `🤖 *AI & SEARCH*`,
        `┌─────────────────────────`,
        `│ ${p}ai           → Chat with AI (Groq)`,
        `│ ${p}clearai      → Clear AI history`,
        `│ ${p}search       → Search the internet`,
        `│ ${p}voice        → AI reply as voice note`,
        `│ ${p}tts          → Text to speech`,
        `│ ${p}aisticker    → Generate AI sticker`,
        `│ ${p}aiimage      → Generate AI image`,
        `└─────────────────────────`,
        ``,
        `📥 *MEDIA & DOWNLOADS*`,
        `┌─────────────────────────`,
        `│ ${p}dl           → Download video/audio`,
        `│ ${p}dlapi        → Download via API (fallback)`,
        `│ ${p}mp3          → Extract audio from URL or video`,
        `│ ${p}gif          → Create GIF from any video URL`,
        `│ ${p}info         → Get video info & thumbnail`,
        `│ ${p}sub          → Extract subtitles from video`,
        `│ ${p}compress     → Compress a video`,
        `│ ${p}reverse      → Reverse a video or audio`,
        `│ ${p}sticker      → Image/video/URL to sticker`,
        `│ ${p}stickercrop  → Crop & zoom before sticker`,
        `│ ${p}stickertext  → Add text to a sticker`,
        `│ ${p}toimage      → Convert sticker to image`,
        `│ ${p}qr           → Generate or decode QR code`,
        `│ ${p}viewonce     → Reveal view-once media`,
        `│ ${p}translate    → Translate text`,
        `└─────────────────────────`,
        ``,
        `🎮 *FUN*`,
        `┌─────────────────────────`,
        `│ ${p}joke         → Random joke`,
        `│ ${p}fact         → Random fun fact`,
        `│ ${p}quote        → Random quote`,
        `│ ${p}8ball        → Magic 8-ball`,
        `│ ${p}poll         → Create a group poll`,
        `└─────────────────────────`,
        ``,
        `🛠️ *UTILITY*`,
        `┌─────────────────────────`,
        `│ ${p}ping         → Latency & uptime`,
        `│ ${p}botstatus    → Bot info`,
        `│ ${p}remind       → Set a reminder`,
        `│ ${p}stats        → Message stats`,
        `│ ${p}aliases      → List shortcuts`,
        `└─────────────────────────`,
        ``,
        `_💡 Type any command alone for usage & examples_`,
      ];

      if (adminUser) {
        menu.push(
          ``,
          `👮 *MODERATION*`,
          `┌─────────────────────────`,
          `│ ${p}warn         → Warn a user`,
          `│ ${p}warnings     → Check warnings`,
          `│ ${p}clearwarn    → Reset warnings`,
          `│ ${p}setmaxwarns  → Set warn limit`,
          `│ ${p}ban/unban    → Ban control`,
          `│ ${p}banlist      → List banned`,
          `│ ${p}add/remove   → Group members`,
          `│ ${p}welcome      → Welcome new members`,
          `│ ${p}goodbye      → Goodbye messages`,
          `└─────────────────────────`,
          ``,
          `🛡️ *PROTECTION*`,
          `┌─────────────────────────`,
          `│ ${p}antilinkon/off    → Anti-link`,
          `│ ${p}allowlink         → Whitelist domain`,
          `│ ${p}allowlinklist     → View whitelist`,
          `│ ${p}antideleteon/off  → Anti-delete`,
          `│ ${p}antideletedm      → Reveals to DM`,
          `│ ${p}antideletechat    → Reveals to chat`,
          `└─────────────────────────`,
          ``,
          `🔤 *WORD FILTER*`,
          `┌─────────────────────────`,
          `│ ${p}wfilteron/off  → Toggle filter`,
          `│ ${p}addword         → Add filtered word`,
          `│ ${p}removeword      → Remove filtered word`,
          `│ ${p}wordlist        → List filtered words`,
          `└─────────────────────────`,
          ``,
          `💬 *AUTO-REPLY*`,
          `┌─────────────────────────`,
          `│ ${p}autoreply        → Add keyword reply`,
          `│ ${p}removeautoreply  → Remove reply`,
          `│ ${p}listautorepies   → List replies`,
          `│ ${p}replyall         → Reply to everything`,
          `│ ${p}stopreplyall     → Stop reply-all`,
          `└─────────────────────────`,
          ``,
          `📅 *SCHEDULER*`,
          `┌─────────────────────────`,
          `│ ${p}send         → Schedule messages`,
          `│ ${p}stopsend     → Stop scheduled`,
          `│ ${p}activesends  → List schedules`,
          `└─────────────────────────`,
          ``,
          `⚙️ *SETTINGS*`,
          `┌─────────────────────────`,
          `│ ${p}boton/off       → Toggle bot`,
          `│ ${p}aion/off        → Toggle AI`,
          `│ ${p}dlon/off        → Toggle downloader`,
          `│ ${p}addadmin        → Add admin`,
          `│ ${p}removeadmin     → Remove admin`,
          `│ ${p}listadmins      → List admins`,
          `│ ${p}setprefix       → Change prefix`,
          `│ ${p}setgroqkey      → Groq AI key`,
          `│ ${p}settavilykey    → Tavily search key`,
          `│ ${p}setaiprompt     → AI personality`,
          `│ ${p}setapikey       → RapidAPI key`,
          `│ ${p}setpackname     → Sticker pack name`,
          `│ ${p}setpackauthor   → Sticker pack author`,
          `│ ${p}broadcast       → Mass message`,
          `│ ${p}say             → Speak as bot`,
          `│ ${p}exportstats     → Export CSV`,
          `│ ${p}clearstats      → Wipe logs`,
          `│ ${p}settings        → View all settings`,
          `└─────────────────────────`,
          ``,
          `⚡ *ALIASES*`,
          `┌─────────────────────────`,
          `│ ${p}alias           → Create shortcut`,
          `│ ${p}removealias     → Remove shortcut`,
          `│ ${p}aliases         → List shortcuts`,
          `└─────────────────────────`,
        );
      }

      // Append active aliases if any exist
      const { getAllAliases } = await import("./aliases.js");
      const aliases = getAllAliases();
      if (aliases.size > 0) {
        const aliasLines = [...aliases.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([alias, cmd]) => `│ ${p}${alias.padEnd(12)} → ${p}${cmd}`);
        menu.push(
          ``,
          `⚡ *YOUR ACTIVE ALIASES*`,
          `┌─────────────────────────`,
          ...aliasLines,
          `└─────────────────────────`,
        );
      }

      menu.push(``, `_📌 Admin sections only visible to admins._`);
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
