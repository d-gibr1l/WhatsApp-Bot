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

1️⃣ *Status Saver & Forwarder*
*Command:* \`.status\`
*Usage:* \`.status @user\` to fetch recent statuses. \`.auto status @user\` to automate it.
*Description:* Fetches someone's statuses and saves them to your DM.

2️⃣ *Group Management*
*Command:* \`.groups\`
*Usage:* \`.groups\` in a DM.
*Description:* Lists all groups the bot is in and provides their ID numbers for remote management.

3️⃣ *Anti-Delete System*
*Command:* \`.antidelete\`
*Usage:* \`.antidelete <on/off> [numbers/all]\`
*Description:* Catches "Delete for Everyone" messages and broadcasts them back to the group or forwards them to your DM.

4️⃣ *View Once Saver*
*Trigger:* reply to a View Once with a trigger emoji (default 👀)
*Usage:* Reply to the View Once with just the emoji — the media is silently saved to your DM.
*Description:* Add or remove trigger emojis in the dashboard under Settings → View Once Saver.
`;

      await Hooper.sendMessage(m.from, { text: hiddenText }, { quoted: m });
    } catch (e) {
      console.error("Hidden Command Error:", e);
    }
  },
};
