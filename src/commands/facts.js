import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// ─── API Fetchers ─────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "WhatsApp-Bot/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getCatFact() {
  const data = await fetchJson("https://catfact.ninja/fact");
  return `🐱 *Cat Fact*\n\n${data.fact}`;
}

async function getDogFact() {
  const data = await fetchJson("https://dogapi.dog/api/v2/facts?limit=1");
  return `🐶 *Dog Fact*\n\n${data.data?.[0]?.attributes?.body ?? "Could not fetch dog fact."}`;
}

async function getMeowFact() {
  const data = await fetchJson("https://meowfacts.herokuapp.com/");
  return `🐾 *Meow Fact*\n\n${data.data?.[0] ?? "Could not fetch meow fact."}`;
}

async function getUselessFact() {
  const data = await fetchJson("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en");
  return `🧠 *Useless Fact*\n\n${data.text}`;
}

async function getChuckNorris() {
  const data = await fetchJson("https://api.chucknorris.io/jokes/random");
  return `💪 *Chuck Norris*\n\n${data.value}`;
}

async function getKanye() {
  const data = await fetchJson("https://api.kanye.rest");
  return `🎤 *Kanye West Said:*\n\n_"${data.quote}"_`;
}

async function getAdvice() {
  const data = await fetchJson("https://api.adviceslip.com/advice");
  return `💡 *Advice #${data.slip.id}*\n\n_"${data.slip.advice}"_`;
}

async function getOnThisDay() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const data = await fetchJson(`https://byabbe.se/on-this-day/${month}/${day}/events.json`);
  const events = data.events?.slice(0, 3) ?? [];
  if (!events.length) return "📅 No events found for today.";
  const lines = events.map((e) => `• *${e.year}* — ${e.description}`).join("\n\n");
  return `📅 *On This Day (${day}/${month})*\n\n${lines}`;
}

async function getNumberFact(number) {
  const n = number ?? Math.floor(Math.random() * 1000);
  const data = await fetchJson(`http://numbersapi.com/${n}/trivia?json`);
  return `🔢 *Number Fact*\n\n${data.text}`;
}


async function getQuote() {
  const data = await fetchJson("https://api.quotable.io/random");
  return `📜 *Quote*\n\n_"${data.content}"_\n\n— *${data.author}*`;
}

async function getBored() {
  const data = await fetchJson("https://bored-api.appbrewery.com/random");
  return (
    `😴 *Bored? Try this!*\n\n` +
    `🎯 *Activity:* ${data.activity}\n` +
    `📂 *Type:* ${data.type}\n` +
    `👥 *Participants:* ${data.participants}\n` +
    `💰 *Cost:* ${data.price === 0 ? "Free" : `$${data.price}`}`
  );
}

// ─── Command Map ──────────────────────────────────────────────────────────────

const factHandlers = {
  cat:       getCatFact,
  dog:       getDogFact,
  meow:      getMeowFact,
  useless:   getUselessFact,
  chuck:     getChuckNorris,
  kanye:     getKanye,
  advice:    getAdvice,
  today:     getOnThisDay,
  quote:     getQuote,
  bored:     getBored,
};

const aliases = {
  chucknorris: "chuck",
  catfact: "cat",
  dogfact: "dog",
  meowfact: "meow",
  uselessfact: "useless",
  onthisday: "today",
};

// ─── Commands ─────────────────────────────────────────────────────────────────

export const factsCommands = {

  fact: {
    adminOnly: false,
    requiresArgs: false,
    description: "Get a random fact or content from a specific category",
    usage: "!fact [category]",
    examples: [
      "!fact",
      "!fact cat",
      "!fact dog",
      "!fact chuck",
      "!fact kanye",
      "!fact advice",
      "!fact today",
      "!fact useless",
      "!fact bored",
      "!fact quote",
    ],
    notes: "Leave blank for a random category. Categories: cat, dog, meow, useless, chuck, kanye, advice, today, quote, bored",
    handler: async (sock, msg, args, from, prefix) => {
      let category = args[0]?.toLowerCase().trim();

      // Resolve aliases
      if (aliases[category]) category = aliases[category];

      // Random category if none given
      if (!category) {
        const keys = Object.keys(factHandlers);
        category = keys[Math.floor(Math.random() * keys.length)];
      }

      const handler = factHandlers[category];
      if (!handler) return replyMsg(sock, from, msg,
        `❌ Unknown category: *${category}*\n\n📌 Available: ${Object.keys(factHandlers).join(", ")}`
      );

      await reactMsg(sock, from, msg, "⏳");

      try {
        const text = await handler();
        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, text);
      } catch (err) {
        console.error(`❌ fact/${category} error:`, err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Could not fetch ${category} fact. Try again later.`);
        await alertOwner(sock, `${prefix}fact ${category}`, err);
      }
    },
  },

  numberfact: {
    adminOnly: false,
    requiresArgs: false,
    description: "Get a fact about a number",
    usage: "!numberfact [number]",
    examples: ["!numberfact 42", "!numberfact 100", "!numberfact"],
    notes: "Leave blank for a random number.",
    handler: async (sock, msg, args, from, prefix) => {
      const number = args[0] ? parseInt(args[0]) : null;
      if (args[0] && isNaN(number)) return replyMsg(sock, from, msg, `❌ Please provide a valid number.`);

      await reactMsg(sock, from, msg, "🔢");
      try {
        const text = await getNumberFact(number);
        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, text);
      } catch (err) {
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Could not fetch number fact.`);
        await alertOwner(sock, `${prefix}numberfact`, err);
      }
    },
  },

};
