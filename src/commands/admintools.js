import { getWarnings, isBanned, getAdmins, supabase } from "../db.js";
import { replyMsg, alertOwner, getTargetNumber, normalizeNumber } from "./helpers.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getMessageCount(number) {
  try {
    const { count } = await supabase
      .from("message_logs")
      .select("*", { count: "exact", head: true })
      .eq("number", number);
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function getLastSeen(number) {
  try {
    const { data } = await supabase
      .from("message_logs")
      .select("sent_at")
      .eq("number", number)
      .order("sent_at", { ascending: false })
      .limit(1);
    return data?.[0]?.sent_at ?? null;
  } catch {
    return null;
  }
}

function formatDate(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const adminToolCommands = {

  user: {
    adminOnly: true,
    requiresArgs: false,
    description: "Look up info about a user — warnings, ban status, message count",
    usage: "!user <number>",
    examples: ["!user 233244587298", "!user 0244587298"],
    notes: "You can also reply to someone's message with !user",
    handler: async (sock, msg, args, from, prefix) => {
      const number = getTargetNumber(msg, args);
      if (!number) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}user*\n\n🔧 *Syntax:*\n${prefix}user <number>\n\n📌 Or reply to a message with ${prefix}user`
      );

      try {
        const [warnings, banned, msgCount, lastSeen, admins] = await Promise.all([
          getWarnings(number),
          isBanned(number),
          getMessageCount(number),
          getLastSeen(number),
          getAdmins(),
        ]);

        const isAdminUser = admins.includes(number);

        await replyMsg(sock, from, msg,
          `👤 *User Lookup: +${number}*\n\n` +
          `🛡️ Role: ${isAdminUser ? "Admin" : "User"}\n` +
          `🚫 Banned: ${banned ? "Yes" : "No"}\n` +
          `⚠️ Warnings: ${warnings.count}\n` +
          `${warnings.count > 0 ? `📋 Reasons:\n${warnings.reasons.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}\n` : ""}` +
          `💬 Messages: ${msgCount}\n` +
          `🕐 Last seen: ${formatDate(lastSeen)}`
        );
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ Failed to look up user: ${err.message}`);
        await alertOwner(sock, `${prefix}user`, err);
      }
    },
  },

  exportstats: {
    adminOnly: true,
    requiresArgs: false,
    description: "Export all message stats as a CSV file",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        await replyMsg(sock, from, msg, "⏳ Generating CSV...");

        const { data, error } = await supabase
          .from("message_logs")
          .select("number, chat_id, is_group, sent_at")
          .order("sent_at", { ascending: false });

        if (error) throw error;
        if (!data?.length) return replyMsg(sock, from, msg, "No stats to export.");

        // Build CSV
        const header = "number,chat_id,is_group,sent_at";
        const rows = data.map((r) =>
          `${r.number},${r.chat_id},${r.is_group},${r.sent_at}`
        );
        const csv = [header, ...rows].join("\n");
        const buffer = Buffer.from(csv, "utf-8");

        await sock.sendMessage(from, {
          document: buffer,
          mimetype: "text/csv",
          fileName: `bot_stats_${new Date().toISOString().split("T")[0]}.csv`,
          caption: `📊 Stats export — ${data.length} records`,
        }, { quoted: msg });

      } catch (err) {
        await replyMsg(sock, from, msg, `❌ Export failed: ${err.message}`);
        await alertOwner(sock, `${prefix}exportstats`, err);
      }
    },
  },

  clearstats: {
    adminOnly: true,
    requiresArgs: false,
    description: "Clear all message logs from the database",
    handler: async (sock, msg, _args, from) => {
      try {
        await supabase.from("message_logs").delete().neq("id", 0);
        await replyMsg(sock, from, msg, "🗑️ All message stats cleared.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ Failed to clear stats: ${err.message}`);
      }
    },
  },

};
