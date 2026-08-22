import { getRandom } from "../System/Function.js";
import { webp2mp4File } from "../System/Uploader.js";
import { toAudio } from "../System/File-Converter.js";
import { exec } from "child_process";
import fs from "fs";
import ffmpegPath from "ffmpeg-static";
import PDFDocument from "pdfkit";
import { CatboxUpload } from "../System/Uploader.js";
import { getBuffer } from "../System/Function2.js";

import util from "util";
let mergedCommands = [
  "toimg",
  "toimage",
  "togif",
  "gif",
  "tomp4",
  "tomp3",
  "toaudio",
  "tourl",
  "topdf",
  "imgtopdf",
  "toqr",
];

export default {
  name: "converters",
  alias: [...mergedCommands],
  uniquecommands: [
    "toimg",
    "togif",
    "gif",
    "tomp4",
    "tomp3",
    "toaudio",
    "tourl",
    "topdf",
    "toqr",
  ],
  description: "All converter related commands",
  start: async (
    Hooper,
    m,
    { inputCMD, text, quoted, doReact, prefix, mime },
  ) => {
    switch (inputCMD) {
      case "toimg":
      case "toimage":
        if (!m.quoted && !/webp/.test(mime)) {
          await doReact("❔");
          return m.reply(
            `Please reply to a *Non-animated* sticker to convert it to image`,
          );
        }
        await doReact("🎴");
        let mediaMess = await Hooper.downloadAndSaveMediaMessage(quoted);
        let ran = await getRandom(".png");
        exec(`"${ffmpegPath}" -i ${mediaMess} ${ran}`, (err) => {
          fs.unlinkSync(mediaMess);
          if (err) {
            Hooper.sendMessage(
              m.from,
              {
                text: `Please mention a *Non-animated* sticker to process ! \n\nOr use *${prefix}togif* / *${prefix}tomp4* to process *Animated* sticker !`,
              },
              { quoted: m },
            );
            return;
          }
          let buffer = fs.readFileSync(ran);
          Hooper.sendMessage(
            m.from,
            { image: buffer, caption: `_Converted by:_  *${botName}*\n` },
            { quoted: m },
          );
          fs.unlinkSync(ran);
        });
        break;

      case "tomp4":
        if (!m.quoted && !/webp/.test(mime)) {
          await doReact("❔");
          return m.reply(
            `Please reply to an *Animated* sticker to convert it to video !`,
          );
        }
        await doReact("🎴");
        let mediaMess2 = await Hooper.downloadAndSaveMediaMessage(quoted);
        let outPath2 = mediaMess2 + ".mp4";

        exec(`${ffmpegPath} -y -i "${mediaMess2}" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -r 15 -c:v libx264 -preset fast -crf 26 -pix_fmt yuv420p -f mp4 "${outPath2}"`, async (err) => {
          if (fs.existsSync(mediaMess2)) fs.unlinkSync(mediaMess2);
          if (err) {
            console.error("FFmpeg tomp4 error:", err);
            await doReact("❌");
            return m.reply("❌ Error: Failed to convert sticker to video.");
          }
          await Hooper.sendMessage(
            m.from,
            {
              video: fs.readFileSync(outPath2),
              caption: `_Converted by:_  *${botName}*\n`,
            },
            { quoted: m }
          );
          if (fs.existsSync(outPath2)) fs.unlinkSync(outPath2);
        });
        break;

      case "togif":
      case "gif":
        if (!m.quoted && !/webp/.test(mime)) {
          await doReact("❔");
          return m.reply(
            `Please reply to an *Animated* sticker to convert it to gif !`,
          );
        }
        await doReact("🎴");
        let mediaMess3 = await Hooper.downloadAndSaveMediaMessage(quoted);
        let outPath = mediaMess3 + ".mp4";

        exec(`${ffmpegPath} -y -i "${mediaMess3}" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -r 15 -c:v libx264 -preset fast -crf 26 -an -pix_fmt yuv420p -movflags +faststart -f mp4 "${outPath}"`, async (err) => {
          if (fs.existsSync(mediaMess3)) fs.unlinkSync(mediaMess3);
          if (err) {
            console.error("FFmpeg togif error:", err);
            await doReact("❌");
            return m.reply("❌ Error: Failed to convert sticker to GIF. Please try again later.");
          }
          await Hooper.sendMessage(
            m.from,
            {
              video: fs.readFileSync(outPath),
              caption: `_Converted by:_  *${botName}*\n`,
              gifPlayback: true,
            },
            { quoted: m }
          );
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        });
        break;

      case "tomp3":
        if (/document/.test(mime)) {
          await doReact("❌");
          return m.reply(
            `Send/Reply Video/Audio You Want To Convert Into MP3 With Caption *${prefix}tomp3*`,
          );
        }
        if (!/video/.test(mime) && !/audio/.test(mime)) {
          await doReact("❌");
          return m.reply(
            `Send/Reply Video/Audio You Want To Convert Into MP3 With Caption *${prefix}tomp3*`,
          );
        }
        if (!m.quoted) {
          await doReact("❔");
          return m.reply(
            `Send/Reply Video/Audio You Want To Convert Into MP3 With Caption ${prefix}tomp3`,
          );
        }
        await doReact("🎶");
        let media = await quoted.download();
        await Hooper.sendPresenceUpdate("recording", m.from);
        let audio = await toAudio(media, "mp4");
        await Hooper.sendMessage(
          m.from,
          {
            document: audio,
            mimetype: "audio/mpeg",
            fileName: `Converted By ${botName} ${m.id}.mp3`,
          },
          { quoted: m },
        );
        await Hooper.sendPresenceUpdate("paused", m.from);
        break;

      case "toaudio":
        if (/document/.test(mime)) {
          await doReact("❌");
          return m.reply(
            `Send/Reply Video/Audio You Want To Convert Into MP3 With Caption *${prefix}tomp3*`,
          );
        }
        if (!/video/.test(mime) && !/audio/.test(mime)) {
          await doReact("❌");
          return m.reply(
            `Send/Reply Video/Audio You Want To Convert Into MP3 With Caption *${prefix}tomp3*`,
          );
        }
        if (!m.quoted) {
          await doReact("❔");
          return m.reply(
            `Send/Reply Video/Audio You Want To Convert Into MP3 With Caption ${prefix}tomp3`,
          );
        }
        await doReact("🎶");
        let media2 = await quoted.download();
        await Hooper.sendPresenceUpdate("recording", m.from);
        let audio2 = await toAudio(media2, "mp4");
        await Hooper.sendMessage(
          m.from,
          { audio: audio2, mimetype: "audio/mpeg" },
          { quoted: m },
        );
        await Hooper.sendPresenceUpdate("paused", m.from);
        break;

      case "tourl":
        if (!/image|video|audio|document|octet|application/.test(mime)) {
          await doReact("❔");
          return m.reply(
            `Please send or reply to an *Image* / *Video* / *Audio* / *Document* to generate a link! With Caption ${prefix}tourl \n\n*Max file size*: 200MB`,
          );
        }
        await doReact("🔗");
        {
          let media5;
          try {
            media5 = await Hooper.downloadAndSaveMediaMessage(quoted);
            let url;
            try {
              url = await CatboxUpload(media5);
            } catch (catboxErr) {
              console.log("Catbox failed, trying fallback...", catboxErr.message);
              // Fallback to GraphOrg or Uguu (we import GraphOrg in Uploader, wait, let's use UploadFileUgu? No, Ugu is imported?)
              // Uploader.js exports GraphOrg, CatboxUpload, UploadFileUgu, webp2mp4File
            }
            if (!url) {
                const { UploadFileUgu } = await import("../System/Uploader.js");
                url = await UploadFileUgu(media5);
            }

            let mediaType = /image/.test(mime)
              ? "Image"
              : /video/.test(mime)
                ? "Video"
                : /audio/.test(mime)
                  ? "Audio"
                  : "File";
            m.reply(`*Generated ${mediaType} URL:* \n\n${url}\n`);
          } catch (e) {
            console.error("[ EXCEPTION ] Tourl error:", e.message);
            await doReact("❌");
            m.reply(
              `*Upload failed!* \n\nThe media could not be downloaded or uploaded. Please try sending the file again.`,
            );
          } finally {
            if (media5 && fs.existsSync(media5)) fs.unlinkSync(media5);
          }
        }
        break;

      case "topdf":
      case "imgtopdf":
        if (/image/.test(mime)) {
          await doReact("📑");
          let mediaMess4 = await Hooper.downloadAndSaveMediaMessage(quoted);

          async function generatePDF(path) {
            return new Promise((resolve, reject) => {
              const doc = new PDFDocument();

              const imageFilePath = mediaMess4.replace(/\\/g, "/");
              doc.image(imageFilePath, 0, 0, {
                width: 612, // Standard width for filling page
                align: "center",
                valign: "center",
              });

              doc.pipe(fs.createWriteStream(path));

              doc.on("end", () => {
                resolve(path);
              });

              doc.end();
            });
          }

          try {
            let randomFileName = `./${Math.floor(
              Math.random() * 1000000000,
            )}.pdf`;
            const pdfPATH = randomFileName;
            await generatePDF(pdfPATH);

            setTimeout(async () => {
              const pdf = fs.readFileSync(pdfPATH);

              Hooper.sendMessage(
                m.from,
                {
                  document: pdf,
                  fileName: `Converted By ${botName}.pdf`,
                },
                { quoted: m },
              );

              fs.unlinkSync(mediaMess4);
              fs.unlinkSync(pdfPATH);
            }, 1000);
          } catch (error) {
            await doReact("❌");
            console.error("[ EXCEPTION ]", error);
            return m.reply(
              `An error occurred while converting the image to PDF.`,
            );
          }
        } else {
          await doReact("❔");
          return m.reply(`Please reply to an *Image* to convert it to PDF!`);
        }
        break;
      case "toqr":
        if (!text) {
          await doReact("❔");
          return m.reply(
            `Please provide text or a URL to convert into a QR code!\n\nExample:\n*${prefix}toqr https://github.com*\n*${prefix}toqr Hello World*`,
          );
        }

        await doReact("✅");
        try {
          const res = await getBuffer(
            `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}`
          );
          await Hooper.sendMessage(
            m.from,
            { image: res, caption: `\n*Source:* ${text}` },
            { quoted: m },
          );
        } catch (e) {
          await doReact("❌");
          return m.reply("❌ Failed to generate QR code.");
        }
        break;

      default:
        break;
    }
  },
};
