import { searchImages, searchGifs, downloadImageUrl } from "../downloader.js";
import { replyMsg, reactMsg } from "./helpers.js";

const MAX_IMAGES     = 10; // hard cap — prevent abuse
const DEFAULT_COUNT  = 3;
const SEND_DELAY_MS  = 600; // delay between sends to avoid WA rate limiting

export const imageCommands = {

  image: {
    adminOnly:   false,
    requiresArgs: true,
    description: "Search and download images. Usage: !image <query> [count]",

    handler: async (sock, msg, args, from) => {
      // ── Parse args ─────────────────────────────────────────────────────────
      // Last arg is treated as count if it's a number
      // e.g. ["superman"]      → query="superman", count=3
      // e.g. ["superman", "6"] → query="superman", count=6
      // e.g. ["iron", "man", "5"] → query="iron man", count=5

      let queryParts = [...args];
      let count = DEFAULT_COUNT;

      const lastArg = queryParts[queryParts.length - 1];
      if (/^\d+$/.test(lastArg)) {
        count = Math.min(Math.max(parseInt(lastArg, 10), 1), MAX_IMAGES);
        queryParts.pop();
      }

      const query = queryParts.join(" ").trim();
      if (!query) {
        return replyMsg(sock, from, msg,
          `❌ Please provide a search term.\n\n` +
          `*Usage:*\n` +
          `• \`!image superman\` — downloads 3 images\n` +
          `• \`!image superman 6\` — downloads 6 images`
        );
      }

      await reactMsg(sock, from, msg, "🔍");

      // ── Search ────────────────────────────────────────────────────────────
      // Fetch count+4 URLs since some will fail to download.
      // Fix: Append 'site:pinterest.com' to force all images to come from Pinterest.
      let imageUrls;
      try {
        imageUrls = await searchImages(query, count + 4);
      } catch (err) {
        console.error(`Image search failed for "${query}":`, err.message);
        return replyMsg(sock, from, msg,
          `❌ Image search failed. Please try again later.`
        );
      }

      if (!imageUrls.length) {
        return replyMsg(sock, from, msg,
          `❌ No images found for *${query}*.`
        );
      }

      await reactMsg(sock, from, msg, "⬇️");

      // ── Download & Send ───────────────────────────────────────────────────
      let sent   = 0;
      let failed = 0;

      for (const url of imageUrls) {
        if (sent >= count) break;

        try {
          const { buffer, contentType } = await downloadImageUrl(url);

          await sock.sendMessage(from, {
            image:    buffer,
            mimetype: contentType,
            // Only caption the first image to avoid spam
            caption:  sent === 0 ? `🖼️ *${query}*` : "",
          }, { quoted: msg });

          sent++;

          // Stagger sends to avoid WhatsApp rate limiting
          if (sent < count) {
            await new Promise(r => setTimeout(r, SEND_DELAY_MS));
          }

        } catch (err) {
          failed++;
          console.error(`Image download failed [${url.slice(0, 60)}]:`, err.message);
          // Continue to next URL — don't abort the whole batch on one failure
        }
      }

      // ── Result feedback ───────────────────────────────────────────────────
      if (sent === 0) {
        await reactMsg(sock, from, msg, "❌");
        return replyMsg(sock, from, msg,
          `❌ Couldn't download any images for *${query}*. The results may be hotlink-protected.\n\nTry a different search term.`
        );
      }

      if (sent < count) {
        await reactMsg(sock, from, msg, "⚠️");
        await replyMsg(sock, from, msg,
          `⚠️ Only found ${sent} downloadable image${sent !== 1 ? "s" : ""} for *${query}* (${failed} failed).`
        );
      } else {
        await reactMsg(sock, from, msg, "✅");
      }
    },
  },

  gif: {
    adminOnly:   false,
    requiresArgs: true,
    description: "Search and download GIFs. Usage: !gif <query> [count]",

    handler: async (sock, msg, args, from) => {
      let queryParts = [...args];
      let count = DEFAULT_COUNT;

      const lastArg = queryParts[queryParts.length - 1];
      if (/^\d+$/.test(lastArg)) {
        count = Math.min(Math.max(parseInt(lastArg, 10), 1), MAX_IMAGES);
        queryParts.pop();
      }

      const query = queryParts.join(" ").trim();
      if (!query) {
        return replyMsg(sock, from, msg,
          `❌ Please provide a search term.\n\n` +
          `*Usage:*\n` +
          `• \`!gif michael jackson\` — downloads 3 GIFs\n` +
          `• \`!gif michael jackson 5\` — downloads 5 GIFs`
        );
      }

      await reactMsg(sock, from, msg, "🔍");

      let gifUrls;
      try {
        gifUrls = await searchGifs(query, count + 2);
      } catch (err) {
        console.error(`GIF search failed for "${query}":`, err.message);
        return replyMsg(sock, from, msg,
          `❌ GIF search failed. Please try again later.`
        );
      }

      if (!gifUrls.length) {
        return replyMsg(sock, from, msg,
          `❌ No GIFs found for *${query}*.`
        );
      }

      await reactMsg(sock, from, msg, "⬇️");

      let sent   = 0;
      let failed = 0;

      for (const url of gifUrls) {
        if (sent >= count) break;

        try {
          const { buffer, contentType } = await downloadImageUrl(url);

          // If the API gave us an mp4, we send it as a gif-playing video.
          // Otherwise if it's a true .gif, we send it as a video to WhatsApp (which handles it if gifPlayback is true)
          // or just as an image. Sending as video with gifPlayback: true is best for both.
          await sock.sendMessage(from, {
            video:    buffer,
            gifPlayback: true,
            caption:  sent === 0 ? `🎥 *${query}*` : "",
          }, { quoted: msg });

          sent++;

          if (sent < count) {
            await new Promise(r => setTimeout(r, SEND_DELAY_MS));
          }

        } catch (err) {
          failed++;
          console.error(`GIF download failed [${url.slice(0, 60)}]:`, err.message);
        }
      }

      if (sent === 0) {
        await reactMsg(sock, from, msg, "❌");
        return replyMsg(sock, from, msg,
          `❌ Couldn't download any GIFs for *${query}*.\n\nTry a different search term.`
        );
      }

      if (sent < count) {
        await reactMsg(sock, from, msg, "⚠️");
        await replyMsg(sock, from, msg,
          `⚠️ Only found ${sent} downloadable GIF${sent !== 1 ? "s" : ""} for *${query}* (${failed} failed).`
        );
      } else {
        await reactMsg(sock, from, msg, "✅");
      }
    },
  },

};
