import { supabase } from "../db.js";
import { replyMsg, alertOwner } from "./helpers.js";

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

      // Safely strip any leading non-alphanumeric character (prefix)
      const stripPrefix = (str) => str.replace(/^[^a-zA-Z0-9]+/, "");
      const alias   = stripPrefix(args[0].toLowerCase());
      // Join the rest of the arguments to support multi-word aliases (e.g. "image cat")
      const command = stripPrefix(args.slice(1).join(" ").toLowerCase());

      // Prevent aliasing to itself
      if (alias === command || command.startsWith(alias + " ")) {
          return replyMsg(sock, from, msg, `❌ Alias and command can't be the same or recursive.`);
      }

      // Ensure the target command actually exists
      const targetCmdName = command.split(" ")[0];
      const { commands } = await import("./registry.js");
      if (!commands[targetCmdName]) {
          return replyMsg(sock, from, msg, `❌ The target command *${prefix}${targetCmdName}* does not exist. Did you reverse the arguments? Remember: *${prefix}alias <new_alias> <existing_command>*`);
      }

      try {
        // Use select then update/insert to avoid onConflict constraint errors if table lacks a unique index
        const { data: existing } = await supabase.from("aliases").select("alias").eq("alias", alias).maybeSingle();
        if (existing) {
          await supabase.from("aliases").update({ command }).eq("alias", alias);
        } else {
          await supabase.from("aliases").insert({ alias, command });
        }
        
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
