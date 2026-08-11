import { replyMsg, reactMsg } from "./helpers.js";
import { getRadars, addRadar, removeRadar, updateRadarLastSeen } from "../db.js";
import Parser from "rss-parser";

const rssParser = new Parser();

// ─── AniList API ──────────────────────────────────────────────────────────────

async function searchAnime(query) {
  const graphqlQuery = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        id
        title {
          romaji
          english
        }
        coverImage {
          large
        }
        nextAiringEpisode {
          airingAt
          timeUntilAiring
          episode
        }
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query: graphqlQuery, variables: { search: query } })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.Media;
}

async function getAnimeById(id) {
  const graphqlQuery = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title {
          romaji
          english
        }
        coverImage {
          large
        }
        nextAiringEpisode {
          airingAt
          timeUntilAiring
          episode
        }
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query: graphqlQuery, variables: { id } })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.Media;
}

// ─── Radar Engine ─────────────────────────────────────────────────────────────

const activeAnimeTimers = new Map(); // animeId -> timeout
let rssPollerInterval = null;

async function scheduleAnime(animeId, sock) {
  if (activeAnimeTimers.has(animeId)) return; // Already scheduled

  try {
    const anime = await getAnimeById(animeId);
    if (!anime || !anime.nextAiringEpisode) return; // Finished airing or not scheduled

    const msUntilAiring = anime.nextAiringEpisode.timeUntilAiring * 1000;
    
    console.log(`[Radar] Scheduled anime ${animeId} in ${msUntilAiring}ms (Ep ${anime.nextAiringEpisode.episode})`);

    const timer = setTimeout(async () => {
      activeAnimeTimers.delete(animeId);
      await notifyAnime(anime, sock);
      // Reschedule for the next episode a few hours later, but wait 5 minutes before checking 
      // AniList to give them time to update their database.
      setTimeout(() => scheduleAnime(animeId, sock), 5 * 60 * 1000);
    }, msUntilAiring);

    activeAnimeTimers.set(animeId, timer);
  } catch (err) {
    console.error(`[Radar] Error scheduling anime ${animeId}:`, err.message);
  }
}

async function notifyAnime(anime, sock) {
  try {
    const radars = await getRadars();
    // Find all chats subscribed to this anime
    const subs = radars.filter(r => r.type === "anime" && r.target === anime.id.toString());
    if (subs.length === 0) return;

    const ep = anime.nextAiringEpisode.episode;
    const title = anime.title.english || anime.title.romaji;
    const text = `🎉 *Release Radar: New Episode!*\n\n📺 *${title}*\n🎬 Episode *${ep}* is now airing!`;

    for (const sub of subs) {
      if (sub.last_seen == ep) continue; // Already notified for this ep somehow
      
      try {
        if (anime.coverImage && anime.coverImage.large) {
          await sock.sendMessage(sub.chat_id, {
            image: { url: anime.coverImage.large },
            caption: text
          });
        } else {
          await sock.sendMessage(sub.chat_id, { text });
        }
        await updateRadarLastSeen(sub.id, ep.toString());
      } catch (err) {
        console.error(`[Radar] Failed to notify ${sub.chat_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Radar] Notify Anime Error:`, err.message);
  }
}

async function pollRssFeeds(sock) {
  try {
    const radars = await getRadars();
    const rssSubs = radars.filter(r => r.type === "rss");
    
    // Group by URL to avoid fetching the same RSS feed multiple times
    const feedUrls = [...new Set(rssSubs.map(r => r.target))];

    for (const url of feedUrls) {
      try {
        const feed = await rssParser.parseURL(url);
        if (!feed.items || feed.items.length === 0) continue;

        const latestItem = feed.items[0];
        const itemIdentifier = latestItem.guid || latestItem.link || latestItem.title;

        // Notify subscribers
        const subsForThisFeed = rssSubs.filter(r => r.target === url);
        for (const sub of subsForThisFeed) {
          if (sub.last_seen !== itemIdentifier) {
            const text = `🎉 *Release Radar: New RSS Entry!*\n\n📖 *${feed.title}*\n📄 *${latestItem.title}*\n🔗 ${latestItem.link}`;
            
            try {
              await sock.sendMessage(sub.chat_id, { text });
              await updateRadarLastSeen(sub.id, itemIdentifier);
            } catch (err) {
              console.error(`[Radar] Failed to send RSS alert:`, err.message);
            }
          }
        }
      } catch (err) {
        console.error(`[Radar] Error parsing RSS feed ${url}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Radar] Poller error:`, err.message);
  }
}

export function stopRadarEngine() {
  console.log("[Radar] Stopping engine...");
  if (rssPollerInterval) {
    clearInterval(rssPollerInterval);
    rssPollerInterval = null;
  }
  for (const timer of activeAnimeTimers.values()) {
    clearTimeout(timer);
  }
  activeAnimeTimers.clear();
}

export function startRadarEngine(sock) {
  console.log("[Radar] Starting engine...");
  
  // 1. Start RSS Poller (every 10 minutes)
  if (rssPollerInterval) clearInterval(rssPollerInterval);
  rssPollerInterval = setInterval(() => pollRssFeeds(sock), 10 * 60 * 1000);
  
  // 2. Clear old anime timers (in case of socket reconnect)
  for (const timer of activeAnimeTimers.values()) {
    clearTimeout(timer);
  }
  activeAnimeTimers.clear();

  // 3. Schedule all tracked anime
  getRadars().then(radars => {
    const animeIds = [...new Set(radars.filter(r => r.type === "anime").map(r => r.target))];
    for (const id of animeIds) {
      scheduleAnime(parseInt(id), sock);
    }
  }).catch(err => console.error("[Radar] Engine init error:", err));
}

// ─── Bot Commands ─────────────────────────────────────────────────────────────

export const radarCommands = {
  radar: {
    adminOnly: false,
    requiresArgs: true,
    description: "Release Radar: Auto-notify when new anime episodes or manga chapters drop.",
    usage: "!radar [add anime <title> | add rss <url> | list | remove <id>]",
    examples: ["!radar add anime tensura", "!radar add rss https://rss.com", "!radar list"],
    handler: async (sock, msg, args, from, prefix) => {
      const subCmd = args[0].toLowerCase();

      if (subCmd === "add") {
        if (args.length < 3) return replyMsg(sock, from, msg, `❌ Missing arguments. Use *${prefix}radar add anime <title>* or *${prefix}radar add rss <url>*`);
        const type = args[1].toLowerCase();
        
        if (type === "anime") {
          const query = args.slice(2).join(" ");
          await reactMsg(sock, from, msg, "⏳");
          try {
            const anime = await searchAnime(query);
            if (!anime) return replyMsg(sock, from, msg, `❌ Anime not found.`);
            
            const title = anime.title.english || anime.title.romaji;
            const subId = `radar_anime_${from}_${anime.id}`;
            
            await addRadar(subId, "anime", anime.id.toString(), from, { title });
            
            // Re-schedule this specific anime in case it wasn't tracked yet
            scheduleAnime(anime.id, sock);
            
            await reactMsg(sock, from, msg, "✅");
            
            let reply = `✅ *Subscribed to Anime:* ${title}\n`;
            if (anime.nextAiringEpisode) {
              const date = new Date(anime.nextAiringEpisode.airingAt * 1000).toLocaleString();
              reply += `\n🎬 *Episode ${anime.nextAiringEpisode.episode}* will air at:\n🗓️ ${date}`;
            } else {
              reply += `\n\n_Note: This anime has no upcoming episodes scheduled right now._`;
            }
            return replyMsg(sock, from, msg, reply);
          } catch (err) {
            console.error(err);
            return replyMsg(sock, from, msg, `❌ Error: ${err.message}`);
          }
        }
        
        if (type === "rss") {
          const url = args[2];
          await reactMsg(sock, from, msg, "⏳");
          try {
            const feed = await rssParser.parseURL(url);
            const subId = `radar_rss_${from}_${Buffer.from(url).toString('base64').substring(0, 15)}`;
            
            const latestIdentifier = feed.items[0] ? (feed.items[0].guid || feed.items[0].link || feed.items[0].title) : "";
            
            await addRadar(subId, "rss", url, from, { title: feed.title || "RSS Feed" });
            // Mark the latest as seen so we don't spam the chat immediately
            await updateRadarLastSeen(subId, latestIdentifier);

            await reactMsg(sock, from, msg, "✅");
            return replyMsg(sock, from, msg, `✅ *Subscribed to RSS Feed:*\n📖 ${feed.title || url}\n\nI will check for new chapters every 10 minutes.`);
          } catch (err) {
            return replyMsg(sock, from, msg, `❌ Invalid RSS Feed: ${err.message}`);
          }
        }

        return replyMsg(sock, from, msg, `❌ Unknown type. Use *anime* or *rss*.`);
      }

      if (subCmd === "list") {
        const radars = await getRadars();
        const chatRadars = radars.filter(r => r.chat_id === from);
        
        if (chatRadars.length === 0) return replyMsg(sock, from, msg, `ℹ️ You have no active Radar subscriptions in this chat.`);
        
        let text = `📡 *Your Release Radar Subscriptions:*\n\n`;
        chatRadars.forEach((r, i) => {
          text += `*${i + 1}.* [${r.type.toUpperCase()}] ${r.meta.title || r.target}\n   ID: \`${r.id}\`\n\n`;
        });
        text += `_To remove, use *${prefix}radar remove <id>*_`;
        return replyMsg(sock, from, msg, text);
      }

      if (subCmd === "remove") {
        const id = args[1];
        if (!id) return replyMsg(sock, from, msg, `❌ Provide the ID to remove (check *${prefix}radar list*).`);
        
        await removeRadar(id);
        return replyMsg(sock, from, msg, `✅ Radar subscription removed.`);
      }

      return replyMsg(sock, from, msg, `❌ Unknown command. Usage: *${prefix}radar [add anime <title> | add rss <url> | list | remove <id>]*`);
    }
  }
};
