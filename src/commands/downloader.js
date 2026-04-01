import { spawn } from "child_process";
import { promises as fsPromises, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { getSetting } from "./db.js";

// ─── Global State ─────────────────────────────────────────────────────────────

let cachedCookiePath = null;
let cookieLastFetched = 0;
const COOKIE_CACHE_TTL = 3600000; // 1 hour

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
    spotify:     /open\.spotify\.com/,
    snapchat:    /snapchat\.com/,
    threads:     /threads\.net/,
    tumblr:      /tumblr\.com/,
    dailymotion: /dailymotion\.com|dai\.ly/,
    rumble:      /rumble\.com/,
    bilibili:    /bilibili\.com|b23\.tv/,
    imgur:       /imgur\.com/,
  };
  
  for (const [platform, regex] of Object.entries(patterns)) {
    if (regex.test(url.toLowerCase())) return platform;
  }
  return null;
}

export function extractUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s()<>]*(?=[.,;:?!]?(?:\s|$))/);
  return match ? match[0] : null;
}

// ─── Cookies Helper (Optimized Caching) ───────────────────────────────────────

async function getCookiesPath() {
  const now = Date.now();
  
  if (cachedCookiePath && (now - cookieLastFetched < COOKIE_CACHE_TTL) && existsSync(cachedCookiePath)) {
    return cachedCookiePath;
  }

  try {
    const cookies = await getSetting("yt_cookies", null);
    if (!cookies?.trim()) return null;
    
    const cookiePath = join(tmpdir(), `yt_cookies_${now}.txt`);
    await fsPromises.writeFile(cookiePath, cookies);
    
    if (cachedCookiePath && existsSync(cachedCookiePath)) {
      await fsPromises.unlink(cachedCookiePath).catch(() => {});
    }
    
    cachedCookiePath = cookiePath;
    cookieLastFetched = now;
    return cookiePath;
  } catch {
    return null;
  }
}

// ─── yt-dlp info fetch ────────────────────────────────────────────────────────

export async function getMediaInfo(url) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported platform.");

  const cookiePath = await getCookiesPath();
  // Added --no-check-formats for faster metadata extraction
  const args = [url, "--dump-json", "--no-playlist", "--no-warnings", "--no-check-formats"];
  if (cookiePath) args.push("--cookies", cookiePath);

  return new Promise((resolve, reject) => {
    let output = "";
    const proc = spawn("yt-dlp", args);
    
    proc.stdout.on("data", d => { output += d.toString(); });
    
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Could not fetch media info for ${platform}.`));
      try {
        const info = JSON.parse(output);
        resolve({
          platform:  info.extractor_key || platform,
          title:     info.title || `${platform} video`,
          thumbnail: info.thumbnail || null,
          duration:  info.duration || null,
          useYtDlp:  true,
        });
      } catch { 
        reject(new Error("Failed to parse media info JSON.")); 
      }
    });
    proc.on("error", reject);
  });
}

// ─── Core stream-based downloader (Optimized for Pure Speed) ──────────────────

export async function downloadWithYtDlp(url, audioOnly = false, quality = "720") {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported platform.");

  const cookiePath = await getCookiesPath();
  const tmpBase    = join(tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const userAgent  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

  let args = [
    url,
    "--user-agent", userAgent,
    "--no-playlist",
    "--no-warnings",
    "--print", "after_move:filepath",
    "--concurrent-fragments", "4", // Maximize download speed for chunked streams
    "--no-part",                   // Write directly to final file (saves disk rename operation)
    "--no-mtime"                   // Skip time metadata writing
  ];

  if (cookiePath) args.push("--cookies", cookiePath);

  if (audioOnly) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", `${tmpBase}.mp3`);
  } else {
    const isImagePlatform = platform === "instagram" || platform === "pinterest";
    const format = isImagePlatform
      ? "best"
      : `best[ext=mp4][height<=${quality}]/bestvideo[height<=${quality}][vcodec^=avc]+bestaudio[acodec^=mp4a]/best[height<=${quality}]/best`;

    args.push("-f", format, "-o", `${tmpBase}.%(ext)s`);

    if (!isImagePlatform) {
      args.push("--merge-output-format", "mp4");
      // Intentionally omitting FFmpeg +faststart to prevent massive disk I/O bottlenecks
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args);
    let errorLog  = "";
    let finalPath = "";

    proc.stdout.on("data", d => { finalPath = d.toString().trim(); });
    proc.stderr.on("data", d => { errorLog += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Download timed out after 3 minutes"));
    }, 180000);

    proc.on("close", async (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        const lastLine = errorLog.trim().split("\n").pop() || "Unknown yt-dlp error";
        return reject(new Error(`yt-dlp failed: ${lastLine.slice(0, 200)}`));
      }

      try {
        if (!finalPath || !existsSync(finalPath)) {
          const dir    = dirname(tmpBase);
          const prefix = basename(tmpBase);
          const files  = (await fsPromises.readdir(dir)).filter(f => f.startsWith(prefix));
          if (files.length === 0) throw new Error("yt-dlp produced no output file.");
          finalPath = join(dir, files[0]);
        }

        const buffer = await fsPromises.readFile(finalPath);
        await fsPromises.unlink(finalPath).catch(() => {}); // Fire and forget cleanup

        const ext = finalPath.split(".").pop().toLowerCase();
        const mimeTypes = {
          mp3: "audio/mpeg",
          mp4: "video/mp4",
          jpg: "image/jpeg", 
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        };

        resolve({
          buffer,
          contentType: mimeTypes[ext] || "video/mp4",
        });
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", reject);
  });
}

// ─── Legacy YouTube buffer export ────────────────────────────────────────────

export const downloadYouTubeToBuffer = (url, audioOnly) => downloadWithYtDlp(url, audioOnly);

// ─── RapidAPI fallback ────────────────────────────────────────────────────────

async function getApiKey() {
  const key = await getSetting("rapidapi_key", null);
  if (!key?.trim()) throw new Error("RapidAPI key not set. Use !setapikey <key> to configure.");
  return key.trim();
}

async function getTikTokMediaApi(url, apiKey) {
  const res = await fetch(
    `https://tiktok-video-no-watermark2.p.rapidapi.com/?url=${encodeURIComponent(url)}&hd=1`,
    { headers: { "x-rapidapi-host": "tiktok-video-no-watermark2.p.rapidapi.com", "x-rapidapi-key": apiKey } }
  );
  if (!res.ok) throw new Error(`TikTok API returned status: ${res.status}`);
  
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || "TikTok API failed to resolve video.");
  
  const videoUrl = data.data?.play || data.data?.hdplay;
  if (!videoUrl) throw new Error("No downloadable video payload found.");
  
  return { title: data.data?.title || "TikTok Video", videoUrl, platform: "TikTok" };
}

async function getGenericMediaApi(url, platform, apiKey) {
  const res = await fetch(
    `https://social-media-video-downloader.p.rapidapi.com/smvd/get/all?url=${encodeURIComponent(url)}`,
    { headers: { "x-rapidapi-host": "social-media-video-downloader.p.rapidapi.com", "x-rapidapi-key": apiKey } }
  );
  if (!res.ok) throw new Error(`${platform} API returned status: ${res.status}`);
  
  const data = await res.json();
  if (!data.success) throw new Error(data.message || `${platform} API failed.`);
  
  const links = data.links || [];
  const best  = links.find(l => l.quality === "720" || l.quality === "720p") || links[0];
  
  return { title: data.title || `${platform} Video`, videoUrl: best?.link || null, platform };
}

export async function downloadWithApi(url) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported platform.");
  
  const apiKey = await getApiKey();
  const info = platform === "tiktok"
    ? await getTikTokMediaApi(url, apiKey)
    : await getGenericMediaApi(url, platform, apiKey);

  if (!info.videoUrl) throw new Error("No valid download link found via API.");

  const res = await fetch(info.videoUrl, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download media buffer: ${res.status}`);
  
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: "video/mp4", title: info.title, platform: info.platform };
}

// ─── Generic buffer download ──────────────────────────────────────────────────

export async function downloadToBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Network error during download: ${res.status}`);
  
  return { 
    buffer: Buffer.from(await res.arrayBuffer()), 
    contentType: res.headers.get("content-type") || "application/octet-stream" 
  };
}