import fs from "fs";
import axios from "axios";
import { Sticker, StickerTypes } from "wa-sticker-formatter";
import { GraphOrg as TelegraPh } from "../System/Uploader.js";
import {   fetchJson,   getBuffer,   GIFBufferToVideoBuffer,   shrinkVideoForSticker, } from "../System/Function2.js";
let mergedCommands = [
  "sticker",
  "s",
  "steal",
  "take",
  "emojimix",
];

export default {
  name: "stickerformat",
  alias: [...mergedCommands],
  uniquecommands: [
    "sticker",
    "steal",
    "emojimix",
  ],
  description: "All Sticker formatting Commands",
  start: async (
    Hooper,
    m,
    {
      inputCMD,
      text,
      pushName,
      prefix,
      doReact,
      args,
      itsMe,
      participants,
      metadata,
      mentionByTag,
      mime,
      isMedia,
      quoted,
      botNumber,
      isBotAdmin,
      groupAdmin,
      isAdmin,
    }
  ) => {
    switch (inputCMD) {
      case "s":
      case "sticker":
        if (/image/.test(mime)) {
          await doReact("🔖");
          let mediaMess = await quoted.download();
          let stickerMess = new Sticker(mediaMess, {
            pack: packname,
            author: pushName,
            type: StickerTypes.FULL,
            categories: ["🤩", "🎉"],
            id: "12345",
            quality: 70,
            background: "transparent",
          });
          const stickerBuffer = await stickerMess.toBuffer();
          Hooper.sendMessage(m.from, { sticker: stickerBuffer }, { quoted: m });
        } else if (/video|gif/.test(mime)) {
          await doReact("🔖");
          let mediaMess = await quoted.download();
          if ((quoted.msg || quoted).seconds > 30) {
            await doReact("❌");
            return Hooper.sendMessage(
              m.from,
              { text: "Please send video less than 30 seconds." },
              { quoted: m }
            );
          }
          // Shrink (resolution/fps/duration) before handing it to
          // wa-sticker-formatter — its video path re-encodes to GIF then
          // resizes every frame with sharp, so the cost scales with input
          // size. The output is always 512x512 anyway, so encoding the
          // source at full res/fps first is pure wasted time.
          mediaMess = await shrinkVideoForSticker(mediaMess);
          let stickerMess = new Sticker(mediaMess, {
            pack: packname,
            author: pushName,
            type: StickerTypes.FULL,
            categories: ["🤩", "🎉"],
            id: "12345",
            quality: 20, // Lower quality to keep file size under WhatsApp's animation limit
            background: "transparent",
          });
          const stickerBuffer2 = await stickerMess.toBuffer();
          Hooper.sendMessage(m.from, { sticker: stickerBuffer2 }, { quoted: m });
        } else {
          await doReact("❌");
          m.reply(
            `Please mention an *image/video* and type *${prefix}s* to create sticker.`
          );
        }
        break;

      case "steal":
      case "take":
        if (!m.quoted) {
          await doReact("❔");
          return m.reply(`Please meantion a sticker to steal it.`);
        }
        await doReact("🀄️");
        let packName, authorName;
        if (!args.join(" ")) {
          packName = pushName;
          authorName = pushName;
        } else if (args.join(" ").includes(",")) {
          packName = args.join(" ").split(",")[0];
          authorName = args.join(" ").split(",")[1];
        } else {
          packName = args.join(" ");
          authorName = args.join(" ");
        }
        if (/webp/.test(mime)) {
          let mediaMess = await quoted.download();
          let stickerMess = new Sticker(mediaMess, {
            pack: packName,
            author: authorName,
            type: StickerTypes.FULL,
            categories: ["🤩", "🎉"],
            id: "12345",
            quality: 70,
            background: "transparent",
          });
          const stickerBuffer = await stickerMess.toBuffer();
          Hooper.sendMessage(m.from, { sticker: stickerBuffer }, { quoted: m });
        } else {
          await doReact("❌");
          m.reply(
            `Please mention a *Sticker* and type *${prefix}steal <packname , authorname>* to create sticker with your name.`
          );
        }

        break;







      case "emojimix":
        if (!args[0]) {
          await doReact("❔");
          return m.reply(
            `Please provide two emojis to combine! *Example :* ${
              prefix + "emojimix"
            } 🦉+🤣`
          );
        }
        await doReact("🔖");
        let [emoji1, emoji2] = args[0].split("+");
        let { data: jsonData } = await axios.get(
          `https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(
            emoji1
          )}_${encodeURIComponent(emoji2)}`
        );

        let imgUrl = jsonData.results[0].url;


        const stcBuff = await getBuffer(imgUrl);
        await fs.promises.writeFile("emoji.png", stcBuff);

        let stickerMess2 = new Sticker("emoji.png", {
          pack: packname,
          author: pushName,
          type: StickerTypes.FULL,
          categories: ["🤩", "🎉"],
          id: "12345",
          quality: 70,
          background: "transparent",
        });

        const stickerBuffer = await stickerMess2.toBuffer();
        await Hooper.sendMessage(
          m.from,
          { sticker: stickerBuffer },
          { quoted: m }
        );
        fs.unlinkSync("emoji.png");

        break;
      default:
        break;
    }
  },
};
