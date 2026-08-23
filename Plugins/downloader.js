import axios from "axios";
let mergedCommands = ["dl", "download"];

const TT = /(?<!\S)https?:\/\/(www\.)?(vm\.|vt\.|m\.)?tiktok\.com\/[^\s]+(?=\s|$)/gi;
const IG = /https?:\/\/(www\.)?instagram\.com\/[^\s]+/gi;
const MF = /(?<!\S)https?:\/\/(www\.)?mediafire\.com\/\S+(?=\s|$)/gi;
const PIN = /https?:\/\/(www\.)?(pinterest\.(com|fr|de|co\.uk|jp|ru|ca|it|com\.au|com\.mx|com\.br|es|pl)|pin\.it)\/[^\s]+/gi;
const FB = /(?<!\S)https?:\/\/(www\.|m\.|web\.)?facebook\.com\/[^\s]+(?=\s|$)/gi;
const TW = /(?<!\S)https?:\/\/(www\.)?(twitter\.com|x\.com)\/[^\s]+(?=\s|$)/gi;
const VD = /https?:\/\/(www\.)?videy\.co\/[^\s]+/gi;
const TH = /https?:\/\/(www\.)?threads\.(net|com)\/[^\s]+/gi;
const MG = /https?:\/\/mega\.nz\/[^\s]+/gi;
const SC = /(?<!\S)https?:\/\/(www\.|on\.)?soundcloud\.com\/[^\s]+(?=\s|$)/gi;
const SP = /https?:\/\/open\.spotify\.com\/[^\s]+/gi;
const YT = /https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[^\s]+/gi;
const SF = /https?:\/\/sfile\.co\/[^\s]+/gi;

const ext = (txt) => {
  if (!txt) return null;
  const match = (regex) => { const m = txt.match(regex); return m ? m[0] : null; };
  if (match(YT)) return { type: "yt", url: match(YT) };
  if (match(TT)) return { type: "tt", url: match(TT) };
  if (match(IG)) return { type: "ig", url: match(IG) };
  if (match(FB)) return { type: "fb", url: match(FB) };
  if (match(TW)) return { type: "tw", url: match(TW) };
  if (match(VD)) return { type: "vd", url: match(VD) };
  if (match(TH)) return { type: "th", url: match(TH) };
  if (match(PIN)) return { type: "pin", url: match(PIN) };
  if (match(SC)) return { type: "sc", url: match(SC) };
  if (match(SP)) return { type: "sp", url: match(SP) };
  if (match(MG)) return { type: "mg", url: match(MG) };
  if (match(MF)) return { type: "mf", url: match(MF) };
  if (match(SF)) return { type: "sf", url: match(SF) };
  return null;
};

export default {
  name: "universalDownloader",
  alias: [...mergedCommands],
  uniquecommands: ["dl", "download"],
  description: "Multi-platform media downloader",
  start: async (Hooper, m, { args, prefix, command, doReact }) => {
    let raw = args.join(" ").trim();
    if (!raw && m.quoted?.text) raw = m.quoted.text;

    if (!raw) {
      return m.reply(`*Universal Downloader*

*Supported Platforms:*
TikTok   Instagram   Pinterest   Facebook
Twitter/X   Threads   Videy   Mega
SoundCloud   Spotify   YouTube   Sfile
MediaFire

*Usage:* ${prefix}dl <url>
*Note:* Reply to a link also works`);
    }

    const url = ext(raw);
    if (!url) {
      return m.reply(`❌ No supported platform URL found in your message.`);
    }

    try {
      if (doReact) await doReact("⏳");

      if (url.type === "yt") {
        const { downloadWithApi } = await import("../src/downloader.js");
        
        const { filePath, contentType, title } = await downloadWithApi(url.url);
        
        const fs = await import("fs");
        try {
          const isAudio = contentType && contentType.startsWith("audio");
          const mediaMsg = isAudio 
             ? { audio: fs.readFileSync(filePath), mimetype: contentType } 
             : { video: fs.readFileSync(filePath), mimetype: contentType, caption: `🎬 *${title}*` };
             
          await Hooper.sendMessage(m.from, mediaMsg, { quoted: m });
        } finally {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      } else {
        const { downloadWithYtDlp } = await import("../src/downloader.js");
        
        const { filePath, url: directUrl, contentType, title } = await downloadWithYtDlp(url.url, false, "720");
        const isAudio = contentType && contentType.startsWith("audio");
        
        if (directUrl) {
           const mediaMsg = isAudio 
              ? { audio: { url: directUrl }, mimetype: contentType } 
              : { video: { url: directUrl }, mimetype: contentType, caption: `🎬 *${title}*` };
           await Hooper.sendMessage(m.from, mediaMsg, { quoted: m });
        } else {
           const fs = await import("fs");
           try {
             const mediaMsg = isAudio 
                ? { audio: fs.readFileSync(filePath), mimetype: contentType } 
                : { video: fs.readFileSync(filePath), mimetype: contentType, caption: `🎬 *${title}*` };
             await Hooper.sendMessage(m.from, mediaMsg, { quoted: m });
           } finally {
             if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
           }
        }
      }
      if (doReact) await doReact("✅");
    } catch (e) {
      let errStr = e.message;
      if (errStr.includes("RapidAPI key not set")) {
          errStr = "To use the YouTube API downloader, you must set your RapidAPI key using `!setapikey <key>` first.";
      } else if (errStr.includes("403")) {
          errStr = "Your RapidAPI key is valid, but you are not subscribed to the 'All Social Media Video Downloader' API. Please subscribe to the free tier on RapidAPI.";
      }
      m.reply(`Error: ${errStr}`);
      if (doReact) await doReact("❌");
    }
  },
};
