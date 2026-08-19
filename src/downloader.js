import { spawn, exec } from "child_process";
import { promises as fsPromises, existsSync, createWriteStream } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "fs";
import * as db from "./db.js";
import { heavyQueue } from "./queue.js";

// ─── yt-dlp Path & Auto-Updater ──────────────────────────────────────────────

export function getYtDlpPath() {
  const localYtDlp = join(process.cwd(), process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (existsSync(localYtDlp)) return localYtDlp;
  if (process.platform === "win32") return "yt-dlp";
  if (existsSync("/app/yt-dlp")) return "/app/yt-dlp";
  if (existsSync("/usr/local/bin/yt-dlp")) return "/usr/local/bin/yt-dlp";
  return "yt-dlp";
}

export async function updateYtDlp() {
  if (process.platform === "win32") {
    console.log("[Downloader] Windows detected — skipping auto-update of yt-dlp.");
    return;
  }
  console.log("[Downloader] Auto-updating yt-dlp to the latest release via pip...");

  return new Promise((resolve) => {
    exec(`pip install --upgrade --break-system-packages yt-dlp`, (err) => {
      if (err) {
        console.warn("[Downloader] Failed to update yt-dlp dynamically:", err.message);
      } else {
        console.log("[Downloader] yt-dlp successfully updated via pip.");
      }
      resolve();
    });
  });
}

// ─── Platform Detection ───────────────────────────────────────────────────────

export function detectPlatform(url) {
  if (!url) return null;
  const patterns = {
    youtube:     /youtube\.com|youtu\.be|youtube-nocookie\.com/,
    tiktok:      /tiktok\.com/,
    instagram:   /instagram\.com|ig\.me/,
    twitter:     /twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com/,
    facebook:    /facebook\.com|fb\.watch|fb\.com|messenger\.com/,
    reddit:      /reddit\.com|redd\.it/,
    twitch:      /twitch\.tv/,
    vimeo:       /vimeo\.com/,
    pinterest:   /pinterest\.com|pin\.it/,
    soundcloud:  /soundcloud\.com/,
    spotify:     /spotify\.com/,
    snapchat:    /snapchat\.com/,
    threads:     /threads\.net/,
    tumblr:      /tumblr\.com/,
    dailymotion: /dailymotion\.com|dai\.ly/,
    rumble:      /rumble\.com/,
    bilibili:    /bilibili\.com|b23\.tv/,
    imgur:       /imgur\.com/,
    ytsearch:    /^ytsearch\d*:/,
  };
  for (const [platform, regex] of Object.entries(patterns)) {
    if (regex.test(url.toLowerCase())) return platform;
  }
  return null;
}

export function extractUrl(text) {
  if (!text) return null;
  const match = text.match(/(https?:\/\/[^\s()<>]+)/);
  if (!match) return null;
  return match[0].replace(/[.,;:?!]+$/, '');
}

// ─── Cookies Helper ───────────────────────────────────────────────────────────

export async function getCookiesPath() {
  try {
    const cookies = await db.getSetting("yt_cookies", null);
    if (!cookies?.trim()) return null;
    const cookiePath = join(tmpdir(), `cookies_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    await fsPromises.writeFile(cookiePath, cookies);
    return cookiePath;
  } catch {
    return null;
  }
}

// ─── yt-dlp info fetch ────────────────────────────────────────────────────────

export async function getMediaInfo(url) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported platform.");

  if (platform === "youtube") {
    try {
      const apiKey = await getApiKey();
      const videoId = extractYouTubeId(url);
      if (videoId) {
        const res = await fetch(`https://social-media-video-downloader.p.rapidapi.com/youtube/v3/video/details?videoId=${videoId}&urlAccess=proxied&renderableFormats=360p&getTranscript=false`, {
          headers: { "x-rapidapi-host": "social-media-video-downloader.p.rapidapi.com", "x-rapidapi-key": apiKey }
        });
        if (res.ok) {
          const data = await res.json();
          const info = data.contents?.[0];
          if (info) {
            return {
              title: info.title || "YouTube Video",
              duration: info.duration?.text || "Unknown",
              thumbnail: info.thumbnails?.[0]?.url || null,
              platform: "youtube",
              useYtDlp: false
            };
          }
        }
      }
    } catch (e) {}
  }


  throw new Error("All YouTube proxy APIs failed, and yt-dlp has been removed per user request.");
}
