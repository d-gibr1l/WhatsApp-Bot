import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// Valid JokeAPI categories
const CATEGORIES = ["programming", "misc", "dark", "pun", "spooky", "christmas"];
const BLACKLIST   = "nsfw,racist,sexist,explicit";

async function fetchJoke(category = "Any") {
  const url = `https://v2.jokeapi.dev/joke/${category}?blacklistFlags=${BLACKLIST}&type=single,twopart`;
  const res  = await fetch(url, { headers: { "User-Agent": "WhatsApp-Bot/1.0" } });
  if (!res.ok) throw new Error(`JokeAPI error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.message ?? "No joke found.");

  if (data.type === "single") {
    return `😂 *Joke*\n\n${data.joke}`;
  } else {
    return `😂 *Joke*\n\n${data.setup}\n\n🥁 ${data.delivery}`;
  }
}

export const jokeCommands = {

  joke: {
    adminOnly: false,
    requiresArgs: false,
    description: "Get a random joke",
    usage: "!joke [category]",
    examples: [
      "!joke",
      "!joke programming",
      "!joke dark",
      "!joke pun",
    ],
    notes: `Categories: ${CATEGORIES.join(", ")}`,
    handler: async (sock, msg, args, from, prefix) => {
      let category = "Any";

      if (args[0]) {
        const input = args[0].toLowerCase().trim();
        if (CATEGORIES.includes(input)) {
          category = input;
        } else {
          return replyMsg(sock, from, msg,
            `❌ Unknown category: *${input}*\n\n📋 *Available categories:*\n${CATEGORIES.map(c => `• ${c}`).join("\n")}\n\n💡 Example: *${prefix}joke programming*`
          );
        }
      }

      await reactMsg(sock, from, msg, "😂");

      try {
        const joke = await fetchJoke(category);
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
