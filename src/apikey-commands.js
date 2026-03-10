// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE TWO COMMANDS inside the commands = { ... } object in commands.js
// ─────────────────────────────────────────────────────────────────────────────

  setapikey: {
    adminOnly: true,
    description: "Set the RapidAPI key  •  !setapikey <key>",
    handler: async (sock, msg, args, from) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg, "Usage: !setapikey <key>");
      try {
        await setSetting("rapidapi_key", key);
        await replyMsg(sock, from, msg, "✅ RapidAPI key updated successfully.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
      }
    },
  },

  checkapikey: {
    adminOnly: true,
    description: "Check if a RapidAPI key is set",
    handler: async (sock, msg, _args, from) => {
      const key = await getSetting("rapidapi_key", null);
      if (!key || key.trim() === "") {
        await replyMsg(sock, from, msg, "❌ No RapidAPI key set. Use !setapikey <key> to set one.");
      } else {
        // Show only first/last 4 chars for security
        const masked = `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
        await replyMsg(sock, from, msg, `✅ RapidAPI key is set.\n🔑 Key: ${masked}`);
      }
    },
  },
