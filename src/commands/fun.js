import { replyMsg, alertOwner } from "./helpers.js";

export const funCommands = {

  quote: {
    adminOnly: false,
    requiresArgs: false,
    description: "Get a random motivational quote",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const res  = await fetch("https://api.quotable.io/random");
        const data = await res.json();
        await replyMsg(sock, from, msg, `💬 *"${data.content}"*\n\n— ${data.author}`);
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Could not fetch a quote right now.");
        await alertOwner(sock, `${prefix}quote`, err);
      }
    },
  },

  fact: {
    adminOnly: false,
    requiresArgs: false,
    description: "Get a random fun fact",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const res  = await fetch("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en");
        const data = await res.json();
        await replyMsg(sock, from, msg, `🧠 *Fun Fact*\n\n${data.text}`);
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Could not fetch a fact right now.");
        await alertOwner(sock, `${prefix}fact`, err);
      }
    },
  },

  "8ball": {
    adminOnly: false,
    requiresArgs: true,
    description: "Ask the magic 8-ball a yes/no question",
    usage: "!8ball <question>",
    examples: ["!8ball Will I pass my exam?", "!8ball Should I go out today?"],
    notes: "Ask any yes/no question and the 8-ball will answer.",
    handler: async (sock, msg, args, from) => {
      const responses = [
        "✅ It is certain.", "✅ Without a doubt.", "✅ Yes, definitely.",
        "✅ You may rely on it.", "✅ Most likely.", "✅ Signs point to yes.",
        "🤔 Reply hazy, try again.", "🤔 Ask again later.", "🤔 Cannot predict now.",
        "❌ Don't count on it.", "❌ My reply is no.", "❌ Very doubtful.", "❌ Outlook not so good.",
      ];
      const answer = responses[Math.floor(Math.random() * responses.length)];
      await replyMsg(sock, from, msg, `🎱 *Magic 8-Ball*\n\n*Q:* ${args.join(" ")}\n\n${answer}`);
    },
  },

  translate: {
    adminOnly: false,
    requiresArgs: true,
    description: "Translate text from English to another language",
    usage: "!translate <language-code> <text>",
    examples: [
      "!translate es Hello, how are you?",
      "!translate fr Good morning everyone",
      "!translate ar Welcome to the group",
    ],
    notes: "Common codes: es, fr, de, ar, zh, pt, hi, ru, ja, it",
    handler: async (sock, msg, args, from, prefix) => {
      if (args.length < 2) {
        return replyMsg(sock, from, msg,
          `📖 *How to use ${prefix}translate*\n\n` +
          `🔧 *Syntax:*\n${prefix}translate <language-code> <text>\n\n` +
          `💡 *Examples:*\n• ${prefix}translate es Hello\n• ${prefix}translate fr Good morning\n\n` +
          `📌 *Common codes:*\nes, fr, de, ar, zh, pt, hi, ru, ja, it`
        );
      }
      const lang = args[0];
      const text = args.slice(1).join(" ");
      try {
        const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${lang}`;
        const res  = await fetch(url);
        const data = await res.json();
        const translated = data.responseData?.translatedText;
        if (!translated || data.responseStatus !== 200) throw new Error("Translation failed");
        await replyMsg(sock, from, msg, `🌐 *Translation (→ ${lang})*\n\n${translated}`);
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Translation failed. Check the language code and try again.");
        await alertOwner(sock, `${prefix}translate — lang: ${args[0]}`, err);
      }
    },
  },

};
