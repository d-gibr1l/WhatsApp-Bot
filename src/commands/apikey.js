import { setSetting } from "../db.js";
import { cachedGetSetting, refreshSettings } from "../cache.js";
import { replyMsg, alertOwner } from "./helpers.js";

export const apikeyCommands = {

  setapikey: {
    adminOnly: true,
    requiresArgs: true,
    description: "Set the RapidAPI key for the media downloader",
    usage: "!setapikey <key>",
    examples: ["!setapikey abc123xyz..."],
    notes: "Get your key from rapidapi.com. Stored securely in the database.",
    handler: async (sock, msg, args, from, prefix) => {
      const key = args[0]?.trim();
      if (!key) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}setapikey*\n\n🔧 *Syntax:*\n${prefix}setapikey <key>\n\n📌 Get your key from rapidapi.com`
      );
      try {
        await setSetting("rapidapi_key", key);
        await refreshSettings();
        await replyMsg(sock, from, msg, "✅ RapidAPI key updated successfully.");
      } catch (err) {
        await replyMsg(sock, from, msg, `❌ ${err.message}`);
        await alertOwner(sock, `${prefix}setapikey`, err);
      }
    },
  },

  checkapikey: {
    adminOnly: true,
    requiresArgs: false,
    description: "Check and test the RapidAPI key against the media APIs",
    handler: async (sock, msg, _args, from, prefix) => {
      const key = cachedGetSetting("rapidapi_key", null);
      if (!key || key.trim() === "") {
        return replyMsg(sock, from, msg, `❌ No RapidAPI key set.\n\n📌 Use *${prefix}setapikey <key>* to set one.`);
      }

      const masked = `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
      await replyMsg(sock, from, msg, `🔑 RapidAPI key is configured: *${masked}*\n\n🔄 Running live connection diagnostics...`);

      const testUrl = "https://www.tiktok.com/@tiktok/video/7106839352654318854";
      let ttStatus = "Testing...";
      let smvdStatus = "Testing...";

      try {
        const ttRes = await fetch(
          `https://tiktok-video-no-watermark2.p.rapidapi.com/?url=${encodeURIComponent(testUrl)}&hd=1`,
          {
            headers: {
              "x-rapidapi-host": "tiktok-video-no-watermark2.p.rapidapi.com",
              "x-rapidapi-key": key,
            },
          }
        );
        if (ttRes.ok) {
          const ttData = await ttRes.json();
          ttStatus = ttData.code === 0 ? "🟢 Active & Working" : `🔴 API Error (code ${ttData.code}): ${ttData.msg || "Unknown error"}`;
        } else {
          ttStatus = `🔴 HTTP Error ${ttRes.status} (${ttRes.statusText})`;
        }
      } catch (err) {
        ttStatus = `🔴 Connection Failed: ${err.message}`;
      }

      try {
        const smvdRes = await fetch(
          `https://social-media-video-downloader.p.rapidapi.com/smvd/get/all?url=${encodeURIComponent(testUrl)}`,
          {
            headers: {
              "x-rapidapi-host": "social-media-video-downloader.p.rapidapi.com",
              "x-rapidapi-key": key,
            },
          }
        );
        if (smvdRes.ok) {
          const smvdData = await smvdRes.json();
          smvdStatus = smvdData.success ? "🟢 Active & Working" : `🔴 API Error: ${smvdData.message || "Failed request"}`;
        } else {
          smvdStatus = `🔴 HTTP Error ${smvdRes.status} (${smvdRes.statusText})`;
        }
      } catch (err) {
        smvdStatus = `🔴 Connection Failed: ${err.message}`;
      }

      await replyMsg(
        sock,
        from,
        msg,
        `📊 *RapidAPI Connection Diagnostics*\n\n` +
          `🔑 *Key:* ${masked}\n\n` +
          `🎵 *TikTok Downloader API:*\n${ttStatus}\n\n` +
          `🎥 *Generic SMVD Downloader API:*\n${smvdStatus}\n\n` +
          `💡 _If you get HTTP 403 or 401, verify that your key is active and subscribed to these specific APIs on RapidAPI._`
      );
    },
  },

};
