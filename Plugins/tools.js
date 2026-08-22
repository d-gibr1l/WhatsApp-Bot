import axios from "axios";
import fs from "fs";
import FormData from "form-data";
import { getBuffer } from "../System/Function2.js";
import url from "url";
import { checkMod } from "../System/MongoDB/MongoDb_Core.js";
import https from "https";
import pm2 from "pm2";
import { fork } from "child_process";

let mergedCommands = [
  "hd",
  "upscale",
  "upscalehd",
  "shorturl",
  "short",
  "tinyurl",
];

export default {
  name: "tools",
  alias: [...mergedCommands],
  uniquecommands: ["upscale"],
  description: "Various handy tool commands",

  start: async (
    Hooper,
    m,
    { inputCMD, text, quoted, mime, doReact, prefix, isCreator, isintegrated },
  ) => {
    switch (inputCMD) {
      case "hd":
      case "upscale":
      case "upscalehd":
        if (doReact) await doReact("❌");
        m.reply("⚠️ The upscale AI service is currently unavailable. We are searching for a replacement API.");
        break;



      case "shorturl":
      case "short":
      case "tinyurl":
        if (!text) {
          await doReact("❔");
          return Hooper.sendMessage(
            m.from,
            { text: `❌ Example: *${prefix}shorturl https://google.com*` },
            { quoted: m },
          );
        }

        await doReact("🔗");
        try {
          let urlToShorten = text;
          if (!urlToShorten.startsWith("http://") && !urlToShorten.startsWith("https://")) {
            urlToShorten = "https://" + urlToShorten;
          }

          const resShort = await fetch(
            `https://tinyurl.com/api-create.php?url=${encodeURIComponent(urlToShorten)}`,
          );
          const short = await resShort.text();

          await Hooper.sendMessage(
            m.from,
            {
              text: `🔗 *Short URL Generated*\n\n*Original:* ${urlToShorten}\n\n*Short:* ${short}`,
            },
            { quoted: m },
          );
        } catch {
          await doReact("❌");
          await Hooper.sendMessage(
            m.from,
            { text: "❌ Failed to shorten url" },
            { quoted: m },
          );
        }
        break;

      default:
        break;
    }
  },
};
