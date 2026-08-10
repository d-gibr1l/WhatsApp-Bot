import { replyMsg, reactMsg, failMsg } from "./helpers.js";

export const tweetCommands = {
  tweet: {
    adminOnly: false,
    requiresArgs: false,
    description: "Generate a realistic fake Twitter/X post",
    usage: "!tweet <text>",
    examples: [
      "!tweet I just built the coolest WhatsApp bot!",
      "Reply to a message with !tweet"
    ],
    handler: async (sock, msg, args, from, prefix) => {
      // 1. Get the text for the tweet
      let tweetText = args.join(" ").trim();
      
      // If no text provided, check if replying to a text message
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!tweetText && quotedMsg) {
        tweetText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";
      }

      if (!tweetText) {
        return replyMsg(sock, from, msg, `📖 *${prefix}tweet*\n\nPlease provide some text or reply to a message.\nExample: *${prefix}tweet Hello world!*`);
      }

      await reactMsg(sock, from, msg, "⏳");

      // 2. Get user's profile picture and name
      const sender = msg.key.participant || msg.key.remoteJid;
      const pushName = msg.pushName || "WhatsApp User";
      const username = pushName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "user";
      
      let avatarUrl = "https://i.imgur.com/8Q5gQkk.png"; // Fallback default avatar
      try {
        const ppUrl = await sock.profilePictureUrl(sender, "image");
        if (ppUrl) avatarUrl = ppUrl;
      } catch (_err) {
        // User might not have a profile picture set or it's hidden, use fallback
      }

      // 3. Generate the tweet image using Some Random API
      // Encode URI components to safely pass text and URLs in the query string
      const apiUrl = `https://some-random-api.com/canvas/misc/tweet?avatar=${encodeURIComponent(avatarUrl)}&comment=${encodeURIComponent(tweetText)}&displayname=${encodeURIComponent(pushName)}&username=${encodeURIComponent(username)}`;

      try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
          throw new Error("API returned an error");
        }
        const buffer = Buffer.from(await response.arrayBuffer());

        // 4. Send the image
        await sock.sendMessage(from, {
          image: buffer,
          caption: "🐦 *Fake Tweet Generated!*"
        }, { quoted: msg });
        
        await reactMsg(sock, from, msg, "✅");
      } catch (err) {
        console.error("❌ Tweet generation error:", err.message);
        failMsg(sock, from, msg, "Failed to generate the tweet image. Please try again later.");
      }
    },
  },
};
