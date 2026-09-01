export default {
  name: "hidden",
  alias: ["hidden"],
  uniquecommands: ["hidden"],
  description: "View the secret hidden commands menu",
  start: async (Hooper, m, { inputCMD, isCreator, doReact }) => {
    try {
      const { checkMod } = await import("../System/MongoDB/MongoDb_Core.js");
      const isMod = isCreator || (await checkMod(m.sender));
      if (!isMod) return;

      await doReact("🕵️‍♂️");

      const hiddenText = `🕵️‍♂️ *HOOPER HIDDEN COMMANDS* 🕵️‍♂️
~ ───────────────────── ~

🔐 *These commands are completely hidden from the public menu and only accessible to the bot owner or moderators.*

1️⃣ *Stealth Revive & Save*
*Command:* \`.//\`
*Usage:* Reply to any message with \`.//\` to silently save its media to your DM.
*View Once:* only \`.//\` works — WhatsApp never sends View Once media to the bot, so it's pulled from your reply.
*Reaction shortcut:* react 🕵️ or 👀 to any *normal* photo/video/voice note to save it the same way (does NOT work on View Once).

2️⃣ *Status Saver & Forwarder*
*Command:* \`.status\`
*Usage:* \`.status @user\` to fetch recent statuses. \`.auto status @user\` to automate it.
*Description:* Fetches someone's statuses and saves them to your DM.

3️⃣ *Group Management*
*Command:* \`.groups\`
*Usage:* \`.groups\` in a DM.
*Description:* Lists all groups the bot is in and provides their ID numbers for remote management.

4️⃣ *Anti-Delete System*
*Command:* \`.antidelete\`
*Usage:* \`.antidelete <on/off> [numbers/all]\`
*Description:* Catches "Delete for Everyone" messages and broadcasts them back to the group or forwards them to your DM.
`;

      await Hooper.sendMessage(m.from, { text: hiddenText }, { quoted: m });
    } catch (e) {
      console.error("Hidden Command Error:", e);
    }
  },
};
