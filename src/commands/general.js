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
        `│ ${p}ai <message>`,
        `│ _Chat with Groq AI (remembers last 20 msgs)_`,
        `│ e.g. ${p}ai explain quantum physics`,
        `│`,
        `│ ${p}search <query>`,
        `│ _Search the internet with real results_`,
        `│ e.g. ${p}search Bitcoin price today`,
        `│`,
        `│ ${p}voice <message>`,
        `│ _AI replies as a voice note_`,
        `│ e.g. ${p}voice tell me a story`,
        `│`,
        `│ ${p}tts <text>`,
        `│ _Convert text to speech audio_`,
        `│ e.g. ${p}tts Hello my name is Sam`,
        `│`,
        `│ ${p}aisticker <prompt>`,
        `│ _Generate an AI sticker image_`,
        `│ e.g. ${p}aisticker a cat wearing sunglasses`,
        `│`,
        `│ ${p}aiimage <prompt>`,
        `│ _Generate an AI image_`,
        `│ e.g. ${p}aiimage sunset over the ocean`,
        `│`,
        `│ ${p}clearai → Clear your AI chat history`,
        `└─────────────────────────`,
        ``,
        `📥 *MEDIA & DOWNLOADS*`,
        `┌─────────────────────────`,
        `│ ${p}dl <url> [quality/audio]`,
        `│ _Download from YouTube, TikTok, Instagram,_`,
        `│ _Twitter/X, Facebook, Reddit & 1000+ sites_`,
        `│ e.g. ${p}dl https://youtu.be/xxxx`,
        `│ e.g. ${p}dl https://youtu.be/xxxx audio`,
        `│ e.g. ${p}dl https://youtu.be/xxxx 1080`,
        `│ 💡 Reply to any link message with ${p}dl`,
        `│`,
        `│ ${p}dlapi <url>`,
        `│ _Fallback downloader using API_`,
        `│ _Use this only if !dl fails_`,
        `│ e.g. ${p}dlapi https://tiktok.com/...`,
        `│`,
        `│ ${p}mp3 <url>  OR  reply to video`,
        `│ _Extract MP3 audio from any URL or video_`,
        `│ e.g. ${p}mp3 https://youtu.be/xxxx`,
        `│ 💡 Reply to a video with ${p}mp3`,
        `│`,
        `│ ${p}sticker`,
        `│ _Convert image or video to sticker_`,
        `│ 💡 Send/reply to media with ${p}sticker`,
        `│`,
        `│ ${p}viewonce`,
        `│ _Reveal a view-once photo or video_`,
        `│ 💡 Reply to the view-once with ${p}viewonce`,
        `│`,
        `│ ${p}translate <text>`,
        `│ _Translate text to English_`,
        `│ e.g. ${p}translate Bonjour comment allez vous`,
        `└─────────────────────────`,
        ``,
        `🎮 *FUN*`,
        `┌─────────────────────────`,
        `│ ${p}joke [category]`,
        `│ _Get a random joke_`,
        `│ Categories: misc, dark, pun, spooky,`,
        `│ christmas, dad, random`,
        `│ e.g. ${p}joke  or  ${p}joke dark`,
        `│`,
        `│ ${p}fact [type]`,
        `│ _Get a random fact_`,
        `│ Types: cat, dog, useless, advice, today, quote`,
        `│ e.g. ${p}fact  or  ${p}fact cat`,
        `│`,
        `│ ${p}8ball <question>`,
        `│ _Ask the magic 8-ball a yes/no question_`,
        `│ e.g. ${p}8ball Will I be rich?`,
        `│`,
        `│ ${p}quote → Random inspirational quote`,
        `└─────────────────────────`,
        ``,
        `🛠️ *UTILITY*`,
        `┌─────────────────────────`,
        `│ ${p}ping → Check bot latency & uptime`,
        `│`,
        `│ ${p}remind <time> <message>`,
        `│ _Set a reminder_`,
        `│ e.g. ${p}remind 30m drink water`,
        `│ e.g. ${p}remind 2h call Sam`,
        `│`,
        `│ ${p}stats → Your message statistics`,
        `│ ${p}botstatus → Bot info & status`,
        `│ ${p}aliases → List your command shortcuts`,
        `└─────────────────────────`,
      ];

      if (adminUser) {
        menu.push(
          ``,
          `👮 *MODERATION*`,
          `┌─────────────────────────`,
          `│ ${p}warn @user [reason]`,
          `│ _Warn a user (auto-ban at max warns)_`,
          `│ e.g. ${p}warn 233XXXXXXX spamming`,
          `│ 💡 Or reply to their message with ${p}warn`,
          `│`,
          `│ ${p}warnings @user → Check someone's warns`,
          `│ ${p}clearwarn @user → Reset their warnings`,
          `│ ${p}setmaxwarns <n> → Set warn limit (default 3)`,
          `│`,
          `│ ${p}ban <number>  OR  reply → ${p}ban`,
          `│ ${p}unban <number> → Remove ban`,
          `│ ${p}banlist → List all banned numbers`,
          `│`,
          `│ ${p}add <number> → Add member to group`,
          `│ ${p}remove <number> → Remove from group`,
          `└─────────────────────────`,
          ``,
          `🛡️ *PROTECTION*`,
          `┌─────────────────────────`,
          `│ ${p}antilinkon / ${p}antilinkoff`,
          `│ _Block links in chat (whitelist allowed)_`,
          `│ ${p}allowlink <domain> → Whitelist a domain`,
          `│ e.g. ${p}allowlink youtube.com`,
          `│ ${p}allowlinklist → View whitelisted domains`,
          `│`,
          `│ ${p}antideleteon / ${p}antideleteoff`,
          `│ _Reveal deleted messages_`,
          `│ ${p}antideletedm → Send reveals to your DM`,
          `│ ${p}antideletechat → Send reveals to chat`,
          `│`,
          `│ ${p}wfilteron / ${p}wfilteroff`,
          `│ _Filter bad words in this chat_`,
          `│ ${p}addword <word> → Add word to filter`,
          `│ ${p}removeword <word> → Remove from filter`,
          `│ ${p}wordlist → List filtered words`,
          `└─────────────────────────`,
          ``,
          `💬 *AUTO-REPLY*`,
          `┌─────────────────────────`,
          `│ ${p}autoreply <keyword> | <response>`,
          `│ _Auto-reply when keyword is detected_`,
          `│ e.g. ${p}autoreply hello | Hi there!`,
          `│`,
          `│ ${p}removeautoreply <keyword>`,
          `│ ${p}listautorepies → List all auto-replies`,
          `│`,
          `│ ${p}replyall <message>`,
          `│ _Reply to every message with this text_`,
          `│ ${p}stopreplyall → Stop replying to all`,
          `└─────────────────────────`,
          ``,
          `📅 *SCHEDULER*`,
          `┌─────────────────────────`,
          `│ ${p}send <interval> <message>`,
          `│ _Send a repeating scheduled message_`,
          `│ e.g. ${p}send 1h Good morning everyone!`,
          `│`,
          `│ ${p}stopsend <id> → Stop a scheduled message`,
          `│ ${p}activesends → List active schedules`,
          `└─────────────────────────`,
          ``,
          `⚙️ *SETTINGS*`,
          `┌─────────────────────────`,
          `│ ${p}boton / ${p}botoff → Enable/disable bot`,
          `│ ${p}aion / ${p}aioff → Enable/disable AI`,
          `│ ${p}dlon / ${p}dloff → Enable/disable downloader`,
          `│`,
          `│ ${p}addadmin <number>  OR  reply → ${p}addadmin`,
          `│ ${p}removeadmin <number> → Remove admin`,
          `│ ${p}listadmins → List all admins`,
          `│`,
          `│ ${p}setprefix <symbol> → Change command prefix`,
          `│ e.g. ${p}setprefix /`,
          `│`,
          `│ ${p}setgroqkey <key> → Set Groq AI key`,
          `│ 📌 Get free key: console.groq.com`,
          `│`,
          `│ ${p}settavilykey <key> → Set Tavily search key`,
          `│ 📌 Get free key: tavily.com`,
          `│`,
          `│ ${p}setaiprompt <prompt> → Set AI personality`,
          `│ e.g. ${p}setaiprompt You are a funny assistant`,
          `│`,
          `│ ${p}setapikey <key> → Set RapidAPI key`,
          `│ 📌 Used by ${p}dlapi as fallback downloader`,
          `│`,
          `│ ${p}setpackname <name> → Sticker pack name`,
          `│ ${p}setpackauthor <name> → Sticker author name`,
          `│`,
          `│ ${p}broadcast <message> → Send to all chats`,
          `│ ${p}say <message> → Send as bot`,
          `│ ${p}exportstats → Export message logs as CSV`,
          `│ ${p}clearstats → Wipe all message logs`,
          `│ ${p}settings → View all current settings`,
          `└─────────────────────────`,
          ``,
          `⚡ *ALIASES*`,
          `┌─────────────────────────`,
          `│ ${p}alias <shortcut> <command>`,
          `│ _Create a shortcut for any command_`,
          `│ e.g. ${p}alias d dl`,
          `│`,
          `│ ${p}removealias <shortcut> → Remove shortcut`,
          `│ ${p}aliases → List all shortcuts`,
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
