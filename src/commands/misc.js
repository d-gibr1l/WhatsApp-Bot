import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { setSetting, getSetting, getAllSettings } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";

export const miscCommands = {

  // ── !setvar / !getvar / !delvar / !allvar ─────────────────────────────────
  setvar: {
    adminOnly: true,
    requiresArgs: true,
    description: "Store a custom variable",
    usage: "!setvar key = value",
    examples: ["!setvar greet = Good morning everyone!", "!setvar link = https://example.com"],
    handler: async (sock, msg, args, from, prefix) => {
      const raw = args.join(" ");
      const eqIdx = raw.indexOf("=");
      if (eqIdx === -1) return replyMsg(sock, from, msg,
        `📖 *${prefix}setvar key = value*\n\n💡 Example:\n• ${prefix}setvar greet = Hello everyone!`
      );
      const key   = "var_" + raw.slice(0, eqIdx).trim().toLowerCase().replace(/\s+/g, "_");
      const value = raw.slice(eqIdx + 1).trim();
      if (!value) return replyMsg(sock, from, msg, "❌ Value cannot be empty.");
      try {
        await setSetting(key, value);
        await refreshSettings();
        await replyMsg(sock, from, msg, `✅ Variable saved:\n*${key.replace("var_", "")}* = ${value}`);
      } catch (err) { await failMsg(sock, from, msg, err, "setvar"); }
    },
  },

  getvar: {
    adminOnly: false,
    requiresArgs: true,
    description: "Get the value of a stored variable",
    usage: "!getvar <key>",
    examples: ["!getvar greet"],
    handler: async (sock, msg, args, from, prefix) => {
      const key = "var_" + args[0]?.toLowerCase().trim();
      if (!args[0]) return replyMsg(sock, from, msg, `📖 *${prefix}getvar <key>*\n\n💡 Example: ${prefix}getvar greet`);
      const value = cachedGetSetting(key, null) || await getSetting(key, null);
      if (!value) return replyMsg(sock, from, msg, `❌ Variable *${args[0]}* not found.`);
      await replyMsg(sock, from, msg, `📦 *${args[0]}*\n\n${value}`);
    },
  },

  delvar: {
    adminOnly: true,
    requiresArgs: true,
    description: "Delete a stored variable",
    usage: "!delvar <key>",
    examples: ["!delvar greet"],
    handler: async (sock, msg, args, from, prefix) => {
      if (!args[0]) return replyMsg(sock, from, msg, `📖 *${prefix}delvar <key>*`);
      const key = "var_" + args[0].toLowerCase().trim();
      try {
        await setSetting(key, null);
        await refreshSettings();
        await replyMsg(sock, from, msg, `🗑️ Variable *${args[0]}* deleted.`);
      } catch (err) { await failMsg(sock, from, msg, err, "delvar"); }
    },
  },

  allvar: {
    adminOnly: true,
    requiresArgs: false,
    description: "Display all stored variables",
    usage: "!allvar",
    handler: async (sock, msg, _args, from) => {
      try {
        const all = await getAllSettings();
        const vars = all.filter(s => s.key.startsWith("var_"))
          .sort((a, b) => a.key.localeCompare(b.key));
        if (vars.length === 0) return replyMsg(sock, from, msg, "📦 No variables stored yet.");
        const lines = vars.map(v => `• *${v.key.replace("var_", "")}* = ${v.value}`).join("\n");
        await replyMsg(sock, from, msg, `📦 *Stored Variables (${vars.length})*\n\n${lines}`);
      } catch (err) { await failMsg(sock, from, msg, err, "allvar"); }
    },
  },

  // ── !google — simple web search ──────────────────────────────────────────
  google: {
    adminOnly: false,
    requiresArgs: true,
    description: "Simple Google search — returns top results",
    usage: "!google <query>",
    examples: [
      "!google latest Ghana news",
      "!google how to make jollof rice",
      "!google Bitcoin price",
    ],
    handler: async (sock, msg, args, from, prefix) => {
      const query = args.join(" ").trim();
      if (!query) return replyMsg(sock, from, msg,
        `📖 *${prefix}google <query>*\n\n💡 Example: ${prefix}google latest news in Ghana`
      );

      await reactMsg(sock, from, msg, "🔍");

      try {
        const encoded = encodeURIComponent(query);
        const res = await fetch(
          `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
          { headers: { "User-Agent": "WhatsApp-Bot/1.0" } }
        );
        const data = await res.json();

        const results = [];

        // Abstract (best answer)
        if (data.AbstractText) {
          results.push(`📌 *${data.Heading || query}*\n${data.AbstractText}`);
          if (data.AbstractURL) results.push(`🔗 ${data.AbstractURL}`);
        }

        // Related topics
        const topics = (data.RelatedTopics || [])
          .filter(t => t.Text && t.FirstURL)
          .slice(0, 4);

        if (topics.length > 0) {
          if (results.length) results.push("");
          results.push("🔎 *Related:*");
          for (const t of topics) {
            results.push(`• ${t.Text.slice(0, 100)}${t.Text.length > 100 ? "..." : ""}\n  ${t.FirstURL}`);
          }
        }

        if (results.length === 0) {
          // Fallback — just return a Google search link
          results.push(`🔍 No instant results found.\n\n🌐 Search on Google:\nhttps://www.google.com/search?q=${encoded}`);
        }

        await reactMsg(sock, from, msg, "✅");
        await replyMsg(sock, from, msg, `🔍 *${query}*\n\n${results.join("\n")}`);
      } catch (err) {
        await failMsg(sock, from, msg, err, "google");
      }
    },
  },

};

export const callCommands = {

  rejectcalls: {
    adminOnly: true,
    requiresArgs: false,
    description: "Automatically reject all incoming calls to the bot",
    usage: "!rejectcalls [on|off]",
    examples: ["!rejectcalls on", "!rejectcalls off"],
    handler: async (sock, msg, args, from, prefix) => {
      const sub = args[0]?.toLowerCase();
      if (!sub || !["on","off"].includes(sub)) return replyMsg(sock, from, msg,
        `📖 *${prefix}rejectcalls [on|off]*\n\n• *${prefix}rejectcalls on* — Auto-reject all calls\n• *${prefix}rejectcalls off* — Allow calls`
      );
      try {
        await setSetting("reject_calls", sub === "on" ? "true" : "false");
        await refreshSettings();
        await replyMsg(sock, from, msg, sub === "on"
          ? "📵 Auto-reject calls enabled. All incoming calls will be rejected."
          : "📞 Auto-reject calls disabled."
        );
      } catch (err) { await failMsg(sock, from, msg, err, "rejectcalls"); }
    },
  },

};
