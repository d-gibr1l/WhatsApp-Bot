import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// ─── API fetchers ─────────────────────────────────────────────────────────────

const BLACKLIST = "nsfw,racist,sexist,explicit";

// JokeAPI categories (programming removed)
const JOKEAPI_CATEGORIES = ["misc", "dark", "pun", "spooky", "christmas"];

async function fetchJokeAPI(category = "Any") {
  const res  = await fetch(
    `https://v2.jokeapi.dev/joke/${category}?blacklistFlags=${BLACKLIST}&type=single,twopart`,
    { headers: { "User-Agent": "WhatsApp-Bot/1.0" } }
  );
  if (!res.ok) throw new Error(`JokeAPI ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.message ?? "No joke found.");
  return data.type === "single"
    ? `😂 *Joke*\n\n${data.joke}`
    : `😂 *Joke*\n\n${data.setup}\n\n🥁 ${data.delivery}`;
}

async function fetchDadJoke() {
  const res = await fetch("https://icanhazdadjoke.com/", {
    headers: { "Accept": "application/json", "User-Agent": "WhatsApp-Bot/1.0" }
  });
  if (!res.ok) throw new Error(`DadJoke ${res.status}`);
  const data = await res.json();
  return `👨 *Dad Joke*\n\n${data.joke}`;
}

async function fetchOfficeJoke() {
  const res = await fetch("https://official-joke-api.appspot.com/random_joke", {
    headers: { "User-Agent": "WhatsApp-Bot/1.0" }
  });
  if (!res.ok) throw new Error(`OfficialJoke ${res.status}`);
  const data = await res.json();
  return `😄 *Joke*\n\n${data.setup}\n\n🥁 ${data.punchline}`;
}

// ─── Category → handler map ───────────────────────────────────────────────────

const SOURCES = {
  // JokeAPI categories
  misc:      () => fetchJokeAPI("misc"),
  dark:      () => fetchJokeAPI("dark"),
  pun:       () => fetchJokeAPI("pun"),
  spooky:    () => fetchJokeAPI("spooky"),
  christmas: () => fetchJokeAPI("christmas"),
  // Other APIs
  dad:       fetchDadJoke,
  random:    fetchOfficeJoke,
};

const ALL_CATEGORIES = Object.keys(SOURCES);

// Random pick from any source
async function fetchRandomJoke() {
  const keys = ALL_CATEGORIES;
  const pick = keys[Math.floor(Math.random() * keys.length)];
  return SOURCES[pick]();
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const jokeCommands = {

  joke: {
    adminOnly: false,
    requiresArgs: false,
    description: "Get a random joke from multiple sources",
    usage: "!joke [category]",
    examples: [
      "!joke",
      "!joke dark",
      "!joke pun",
      "!joke dad",
      "!joke random",
    ],
    notes: `Categories: ${ALL_CATEGORIES.join(", ")}`,
    handler: async (sock, msg, args, from, prefix) => {
      let fetcher = fetchRandomJoke;

      if (args[0]) {
        const input = args[0].toLowerCase().trim();
        if (SOURCES[input]) {
          fetcher = SOURCES[input];
        } else {
          return replyMsg(sock, from, msg,
            `❌ Unknown category: *${input}*\n\n📋 *Available categories:*\n${ALL_CATEGORIES.map(c => `• ${c}`).join("\n")}\n\n💡 Example: *${prefix}joke dad*`
          );
        }
      }

      await reactMsg(sock, from, msg, "😂");

      try {
        const joke = await fetcher();
        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, joke);
      } catch (err) {
        console.error("❌ Joke error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Couldn't fetch a joke: ${err.message}`);
        await alertOwner(sock, `${prefix}joke`, err);
      }
    },
  },

};
