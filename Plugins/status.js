import { messageData } from "../System/MongoDB/MongoDB_Schema.js";

export default {
  name: "status",
  alias: ["status", "getstatus"],
  uniquecommands: ["status"],
  description: "Get recent WhatsApp statuses of a specific user",
  start: async (Hooper, m, { text, prefix, doReact, args }) => {
    if (!text) {
      if (doReact) await doReact("❔");
      return m.reply(`Please provide a phone number!\n\nExample: *${prefix}status 05429485334*`);
    }

    if (doReact) await doReact("🔍");

    let number = text.replace(/[^0-9]/g, "");

    // If it starts with 0, replace with bot's country code dynamically
    if (number.startsWith("0")) {
      const botNumber = Hooper.user.id.split(":")[0];
      // Assume local number is 10 digits (GH, NG, UK, etc. vary, but usually start with 0)
      // We will try to extract the bot's country code. For GH (233), local is 0 + 9 digits = 10.
      // So if length is 10, bot country code is 233.
      // A safe generic way is to just replace the first '0' with the bot's country code prefix.
      let cc = "";
      if (botNumber.startsWith("233")) cc = "233"; // Ghana
      else if (botNumber.startsWith("234")) cc = "234"; // Nigeria
      else if (botNumber.startsWith("1")) cc = "1"; // US/Canada
      else if (botNumber.startsWith("91")) cc = "91"; // India
      else if (botNumber.startsWith("62")) cc = "62"; // Indonesia
      else cc = botNumber.substring(0, 3); // Fallback 
      
      number = cc + number.substring(1);
    }
    
    const targetJid = `${number}@s.whatsapp.net`;

    let docs = [];
    try {
      docs = await messageData.find({ chatId: "status@broadcast", participant: targetJid }).lean();
    } catch (e) {
      console.error(e);
    }

    const statuses = docs.map(d => d.data).sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

    if (statuses.length === 0) {
      if (doReact) await doReact("❌");
      return m.reply(`No recent statuses found for ${number}. Note that I can only fetch statuses posted while I am online.`);
    }

    if (doReact) await doReact("✅");
    await m.reply(`Found ${statuses.length} recent status(es) for ${number}. Sending them now...`);

    for (const msg of statuses) {
      try {
        await Hooper.sendMessage(m.from, { forward: msg }, { quoted: m });
        await new Promise(res => setTimeout(res, 1000));
      } catch (e) {
        console.error("Error sending status:", e.message);
      }
    }
  }
};
