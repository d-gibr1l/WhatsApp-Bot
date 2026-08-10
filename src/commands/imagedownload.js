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
        const pinterestQuery = `${query} site:pinterest.com`;
        imageUrls = await searchImages(pinterestQuery, count + 4);
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

      // ── Download Concurrently ─────────────────────────────────────────────
      const downloadPromises = imageUrls.map(url =>
        downloadImageUrl(url).then(res => res).catch(err => {
          console.error(`Image download failed [${url.slice(0, 60)}]:`, err.message);
          return null;
        })
      );
      
      const downloadedImages = (await Promise.all(downloadPromises))
        .filter(Boolean)
        .slice(0, count);

      let sent = 0;

      // ── Send Sequentially (to avoid rate limits) ──────────────────────────
      for (let i = 0; i < downloadedImages.length; i++) {
        const { buffer, contentType } = downloadedImages[i];
        
        await sock.sendMessage(from, {
          image:    buffer,
          mimetype: contentType,
          caption:  i === 0 ? `🖼️ *${query}*` : "",
        }, { quoted: msg });
        
        sent++;
        if (i < downloadedImages.length - 1) {
          await new Promise(r => setTimeout(r, SEND_DELAY_MS));
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

};
