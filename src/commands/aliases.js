import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { replyMsg, alertOwner } from "./helpers.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Alias Cache ──────────────────────────────────────────────────────────────

let aliasCache = new Map(); // alias -> command

export async function loadAliases() {
  try {
    const { data, error } = await supabase.from("aliases").select("alias, command");
    if (error) throw error;
    aliasCache = new Map(data.map((r) => [r.alias.toLowerCase(), r.command.toLowerCase()]));
    console.log(`✅ Aliases loaded — ${aliasCache.size} aliases`);
  } catch (err) {
    console.error("❌ loadAliases:", err.message);
  }
}

export function resolveAlias(cmdName) {
  return aliasCache.get(cmdName.toLowerCase()) ?? cmdName;
}

export function getAllAliases() {
  return aliasCache;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const aliasCommands = {

  alias: {
    adminOnly: true,
    requiresArgs: true,
    description: "Create a shortcut alias for any command",
    usage: "!alias <alias> <command>",
    examples: [
      "!alias vo viewonce",
      "!alias s sticker",
      "!alias ai2 ai",
    ],
    notes: "Don't include the prefix. Use !removealias to delete.",
    handler: async (sock, msg, args, from, prefix) => {
      if (args.length < 2) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}alias*\n\n` +
        `🔧 *Syntax:*\n${prefix}alias <alias> <command>\n\n` +
        `💡 *Examples:*\n` +
        `• ${prefix}alias vo viewonce\n` +
        `• ${prefix}alias s sticker\n\n` +
        `📌 Don't include the prefix (!) in alias or command`
      );

      const alias   = args[0].toLowerCase().replace(/^!/, "");
      const command = args[1].toLowerCase().replace(/^!/, "");

      // Prevent aliasing to itself
      if (alias === command) return replyMsg(sock, from, msg, `❌ Alias and command can't be the same.`);

      try {
        await supabase.from("aliases")
          .upsert({ alias, command }, { onConflict: "alias" });
        aliasCache.set(alias, command);
        await replyMsg(sock, from, msg,
          `✅ Alias created!\n\n*${prefix}${alias}* → *${prefix}${command}*`
        );
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}alias`, err);
      }
    },
  },

  removealias: {
    adminOnly: true,
    requiresArgs: true,
    description: "Remove a command alias",
    usage: "!removealias <alias>",
    examples: ["!removealias vo"],
    handler: async (sock, msg, args, from, prefix) => {
      const alias = args[0].toLowerCase().replace(/^!/, "");
      if (!alias) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}removealias*\n\n🔧 *Syntax:*\n${prefix}removealias <alias>`
      );

      if (!aliasCache.has(alias)) return replyMsg(sock, from, msg,
        `ℹ️ No alias found for *${prefix}${alias}*`
      );

      try {
        await supabase.from("aliases").delete().eq("alias", alias);
        aliasCache.delete(alias);
        await replyMsg(sock, from, msg, `✅ Alias *${prefix}${alias}* removed.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}removealias`, err);
      }
    },
  },

  aliases: {
    adminOnly: false,
    requiresArgs: false,
    description: "List all active command aliases",
    handler: async (sock, msg, _args, from, prefix) => {
      if (aliasCache.size === 0) return replyMsg(sock, from, msg,
        `No aliases set.\n\n📌 Create one with: *${prefix}alias <alias> <command>*`
      );

      const lines = [...aliasCache.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([alias, cmd]) => `• *${prefix}${alias}* → *${prefix}${cmd}*`);

      await replyMsg(sock, from, msg,
        `*⚡ Command Aliases (${aliasCache.size})*\n\n${lines.join("\n")}`
      );
    },
  },

};
