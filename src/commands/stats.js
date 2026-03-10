import { getStats } from "../db.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const statsCommands = {

  stats: {
    adminOnly: true,
    requiresArgs: false,
    description: "Show bot message statistics",
    handler: async (sock, msg, _args, from, prefix) => {
      try {
        const logs = await getStats();
        if (!logs.length) return replyMsg(sock, from, msg, "No stats yet.");
        const total  = logs.length;
        const groups = logs.filter((l) => l.is_group).length;
        const dms    = total - groups;
        const senderMap = {};
        for (const l of logs) senderMap[l.number] = (senderMap[l.number] ?? 0) + 1;
        const topSenders = Object.entries(senderMap)
          .sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([num, count], i) => `${i + 1}. ${num} — ${count} msgs`).join("\n");
        const today = new Date().toISOString().split("T")[0];
        const todayCount = logs.filter((l) => l.sent_at?.startsWith(today)).length;
        await replyMsg(sock, from, msg,
          `*📊 Bot Statistics*\n\n` +
          `📨 Total: ${total}\n👥 Groups: ${groups}\n💬 DMs: ${dms}\n📅 Today: ${todayCount}\n\n` +
          `*🏆 Top Senders*\n${topSenders}`
        );
      } catch (err) {
        await replyMsg(sock, from, msg, "❌ Failed to fetch stats.");
        await alertOwner(sock, `${prefix}stats`, err);
      }
    },
  },

};
