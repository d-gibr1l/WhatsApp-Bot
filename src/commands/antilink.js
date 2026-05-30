import { setSetting, warnUser, banNumber, supabase } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";

// ─── Allowed Links Cache ──────────────────────────────────────────────────────

let allowedLinkCache = new Set();

export async function loadAllowedLinks() {
  try {
    const { data, error } = await supabase.from("allowed_links").select("domain");
    if (error) throw error;
    allowedLinkCache = new Set(data.map((r) => r.domain.toLowerCase()));
    console.log(`✅ Allowed links loaded — ${allowedLinkCache.size} domains`);
  } catch (err) {
    console.error("❌ loadAllowedLinks:", err.message);
  }
}

// ─── Link Detection ───────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s]+|www\.[^\s]+|[^\s]+\.(com|net|org|io|co|gg|tv|me|ly|link|xyz|info|app|dev)[^\s]*/gi;

function extractLinks(text) {
  return text.match(URL_REGEX) ?? [];
}

function isAllowedLink(url) {
  const lower = url.toLowerCase();
  for (const domain of allowedLinkCache) {
    if (lower.includes(domain)) return true;
  }
  return false;
}

// ─── Anti-link Handler (called from handler.js) ───────────────────────────────

export async function handleAntiLink(sock, msg, text, sender, from) {
  const active = cachedGetSetting("antilink_active", "false");
  if (active !== "true") return false;

  // Only enforce in groups
  if (!from.endsWith("@g.us")) return false;

  const links = extractLinks(text);
  if (!links.length) return false;

  // Check if all links are whitelisted
  const blockedLink = links.find((l) => !isAllowedLink(l));
  if (!blockedLink) return false;

  // Try to delete the message
  try {
    await sock.sendMessage(from, { delete: msg.key });
  } catch {
    // Bot may not be group admin — ignore
  }

  // Warn the user
  const maxWarns = parseInt(cachedGetSetting("max_warnings", "3"));
  try {
    const count = await warnUser(sender, `Sent a link: ${blockedLink}`);
    if (count >= maxWarns) {
      await banNumber(sender, `Auto-banned after ${count} warnings (anti-link)`);
      await sock.sendMessage(from, {
        text: `🚫 *${sender}* has been auto-banned after ${count} warnings for sending links.`,
      });
    } else {
      await sock.sendMessage(from, {
        text:
          `🔗 *Links are not allowed in this group.*\n\n` +
          `⚠️ @${sender} — Warning ${count}/${maxWarns}`,
        mentions: [`${sender}@s.whatsapp.net`],
      });
    }
  } catch (err) {
    console.error("❌ Anti-link warn error:", err.message);
  }

  return true;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const antilinkCommands = {

  antilinkon: {
    adminOnly: true,
    requiresArgs: false,
    description: "Enable anti-link protection in groups",
    handler: async (sock, msg, _args, from) => {
      await setSetting("antilink_active", "true");
      await refreshSettings();
      await replyMsg(sock, from, msg, "✅ Anti-link enabled. Links will be deleted and senders warned.");
    },
  },

  antilinkoff: {
    adminOnly: true,
    requiresArgs: false,
    description: "Disable anti-link protection",
    handler: async (sock, msg, _args, from) => {
      await setSetting("antilink_active", "false");
      await refreshSettings();
      await replyMsg(sock, from, msg, "🔴 Anti-link disabled.");
    },
  },

  allowlink: {
    adminOnly: true,
    requiresArgs: true,
    description: "Whitelist a domain so its links are not blocked",
    usage: "!allowlink <domain>",
    examples: ["!allowlink youtube.com", "!allowlink wa.me"],
    handler: async (sock, msg, args, from, prefix) => {
      const domain = args[0]?.toLowerCase().trim();
      if (!domain) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}allowlink*\n\n🔧 *Syntax:*\n${prefix}allowlink <domain>\n\n💡 *Example:*\n• ${prefix}allowlink youtube.com`
      );
      try {
        await supabase.from("allowed_links").upsert({ domain }, { onConflict: "domain" });
        allowedLinkCache.add(domain);
        await replyMsg(sock, from, msg, `✅ *${domain}* added to allowed links.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}allowlink`, err);
      }
    },
  },

  removeallowlink: {
    adminOnly: true,
    requiresArgs: true,
    description: "Remove a domain from the whitelist",
    usage: "!removeallowlink <domain>",
    examples: ["!removeallowlink youtube.com"],
    handler: async (sock, msg, args, from, prefix) => {
      const domain = args[0]?.toLowerCase().trim();
      if (!domain) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}removeallowlink*\n\n🔧 *Syntax:*\n${prefix}removeallowlink <domain>`
      );
      try {
        await supabase.from("allowed_links").delete().eq("domain", domain);
        allowedLinkCache.delete(domain);
        await replyMsg(sock, from, msg, `✅ *${domain}* removed from allowed links.`);
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}removeallowlink`, err);
      }
    },
  },

  allowlinklist: {
    adminOnly: true,
    requiresArgs: false,
    description: "List all whitelisted domains",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const { data } = await supabase.from("allowed_links").select("domain").order("domain");
        if (!data?.length) return replyMsg(sock, from, msg,
          `No whitelisted domains.\n\n📌 Add one with: *${prefix}allowlink <domain>*`
        );
        await replyMsg(sock, from, msg,
          `*🔗 Allowed Domains (${data.length})*\n\n${data.map((d) => `• ${d.domain}`).join("\n")}`
        );
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch allowed links.");
        await alertOwner(sock, `${prefix}allowlinklist`, err);
      }
    },
  },

};