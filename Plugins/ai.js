import { systemData } from "../System/MongoDB/MongoDB_Schema.js";
import { checkMod } from "../System/MongoDB/MongoDb_Core.js";
import axios from "axios";

let mergedCommands = [
  "ai",
  "aion",
  "aioff",
  "setgroqkey",
  "setaiprompt",
  "clearai",
];

const aiConversations = new Map();
const MAX_HISTORY = 20;

export default {
  name: "ai",
  alias: [...mergedCommands],
  uniquecommands: ["ai", "clearai", "setgroqkey", "setaiprompt"],
  description: "AI assistant powered by Groq",
  start: async (Hooper, m, { inputCMD, text, pushName, prefix, doReact, isCreator, args }) => {
    
    let sys = await systemData.findOne({ id: "1" });
    if (!sys) {
        sys = await systemData.create({ id: "1" });
    }

    const isUsermod = await checkMod(m.sender);
    const isAdmin = isCreator || isUsermod;

    switch (inputCMD) {
      case "ai": {
        if (!sys.aiActive) {
          if (doReact) await doReact("❌");
          return m.reply("🤖 AI chat is currently disabled.");
        }
        
        if (!sys.groqKey) {
            if (doReact) await doReact("❌");
            return m.reply(`❌ Groq API key not set. Admin must run *${prefix}setgroqkey <key>* first.\n\n📌 Get a free key at: console.groq.com`);
        }

        if (!text) {
          if (doReact) await doReact("❔");
          return m.reply(`Please provide a message for the AI!\n\nExample: *${prefix}ai What is the capital of Ghana?*`);
        }

        if (doReact) await doReact("🤖");

        let history = aiConversations.get(m.from) || [];
        const systemPrompt = sys.aiPrompt;

        const messages = [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: text },
        ];

        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages,
                max_tokens: 1024,
                temperature: 0.7,
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${sys.groqKey}`,
                },
                timeout: 15000
            });

            const reply = res.data?.choices?.[0]?.message?.content?.trim();
            if (!reply) throw new Error("No response from Groq.");

            history.push({ role: "user", content: text });
            history.push({ role: "assistant", content: reply });

            // Truncate history
            if (history.length > MAX_HISTORY * 2) {
                history = history.slice(history.length - (MAX_HISTORY * 2));
            }
            aiConversations.set(m.from, history);

            return m.reply(reply);
        } catch (err) {
            console.error("❌ AI error:", err.response?.data || err.message);
            if (doReact) await doReact("❌");
            const errStr = err.response?.data?.error?.message || err.message;
            return m.reply(`❌ AI error: ${errStr}`);
        }
      }

      case "clearai": {
        if (!isAdmin) return m.reply("❌ Only Admins/Mods can use this command.");
        aiConversations.delete(m.from);
        if (doReact) await doReact("✅");
        return m.reply("🗑️ AI conversation history cleared for this chat.");
      }

      case "aion": {
        if (!isAdmin) return m.reply("❌ Only Admins/Mods can use this command.");
        await systemData.updateOne({ id: "1" }, { aiActive: true });
        if (doReact) await doReact("✅");
        return m.reply("✅ AI chat enabled.");
      }

      case "aioff": {
        if (!isAdmin) return m.reply("❌ Only Admins/Mods can use this command.");
        await systemData.updateOne({ id: "1" }, { aiActive: false });
        if (doReact) await doReact("🔴");
        return m.reply("🔴 AI chat disabled.");
      }

      case "setgroqkey": {
        if (!isAdmin) return m.reply("❌ Only Admins/Mods can use this command.");
        const key = args[0]?.trim();
        if (!key) {
            if (doReact) await doReact("❔");
            return m.reply(`📖 *How to use ${prefix}setgroqkey*\n\n🔧 *Syntax:*\n${prefix}setgroqkey <key>\n\n📌 Get your free key from console.groq.com`);
        }
        await systemData.updateOne({ id: "1" }, { groqKey: key });
        if (doReact) await doReact("✅");
        return m.reply("✅ Groq API key saved. Try *!ai hello* to test.");
      }

      case "setaiprompt": {
        if (!isAdmin) return m.reply("❌ Only Admins/Mods can use this command.");
        if (!text) {
            if (doReact) await doReact("❔");
            return m.reply(`📖 *How to use ${prefix}setaiprompt*\n\n🔧 *Syntax:*\n${prefix}setaiprompt <prompt>\n\nExample: *${prefix}setaiprompt You are a helpful bot.*`);
        }
        await systemData.updateOne({ id: "1" }, { aiPrompt: text });
        if (doReact) await doReact("✅");
        return m.reply("✅ AI system prompt updated.");
      }

      default:
        break;
    }
  },
};
