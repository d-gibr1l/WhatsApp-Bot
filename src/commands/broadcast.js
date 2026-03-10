import { getAllowedGroups } from "../db.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const broadcastCommands = {

  broadcast: {
    adminOnly: true,
    requiresArgs: true,
    description: "Send a message to all allowed groups at once",
    usage: "!broadcast <message>",
    examples: ["!broadcast Good morning everyone! 🌅"],
    notes: "Only sends to groups added with !allowgroup",
    handler: async (sock, msg, args, from, prefix) => {
      const text   = args.join(" ");
      const groups = await getAllowedGroups();
      if (!groups.length) return replyMsg(sock, from, msg,
        `❌ No allowed groups found.\n\n📌 First add groups using *${prefix}allowgroup* inside each group.`
      );
      let sent = 0, failed = 0;
      for (const group of groups) {
        try {
          await sock.sendMessage(group.group_id, { text: `📢 *Broadcast*\n\n${text}` });
          sent++;
        } catch (err) {
          failed++;
          await alertOwner(sock, `${prefix}broadcast — group ${group.group_id}`, err);
        }
      }
      await replyMsg(sock, from, msg, `📢 Broadcast complete.\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
    },
  },

};
