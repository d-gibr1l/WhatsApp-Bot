import { getWordFilters, warnUser, banUser } from "../db.js";

export async function handleWordFilter(sock, msg, text, sender, from) {
  try {
    const filters = await getWordFilters(from);
    if (!filters || filters.length === 0) return false;

    const lower = text.toLowerCase();
    const matched = filters.find(f => lower.includes(f.word.toLowerCase()));

    if (!matched) return false;

    // Delete message
    try {
      await sock.sendMessage(from, { delete: msg.key });
    } catch (e) {}

    // Warn user
    const count = await warnUser(sender, `Used filtered word: "${matched.word}"`);
    if (count >= 3) {
      await banUser(sender);
      await sock.sendMessage(from, {
        text: `🚫 *@${sender.split("@")[0]}* has been auto-banned after ${count} warnings for using filtered words.`,
        mentions: [sender]
      });
    } else {
      await sock.sendMessage(from, {
        text: `⚠️ *@${sender.split("@")[0]}*, your message was removed.\n\n🚫 *Reason:* Filtered word detected ("${matched.word}")\n⚠️ *Warnings:* ${count}/3`,
        mentions: [sender]
      });
    }

    return true;
  } catch (err) {
    console.error("❌ Word filter error:", err.message);
    return false;
  }
}
