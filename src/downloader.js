import { spawn, exec } from "child_process";
import { promises as fsPromises, existsSync, readdirSync } from "fs";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { getSetting } from "./db.js";
import { heavyQueue } from "./queue.js";

// ─── yt-dlp Path & Auto-Updater ──────────────────────────────────────────────

export function getYtDlpPath() {
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
  console.log("[Downloader] Auto-updating yt-dlp to the latest release...");
  const targetPath = "/app/yt-dlp";
  const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  return new Promise((resolve) => {
    exec(`curl -L ${url} -o ${targetPath} && chmod a+rx ${targetPath}`, (err) => {
      if (err) {
        console.warn("[Downloader] Failed to update yt-dlp dynamically:", err.message);
      } else {
        console.log("[Downloader] yt-dlp successfully updated to latest version at:", targetPath);
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

// ─── Cookies Helper ───────────────────────────────────────────────────────────

export async function getCookiesPath() {
  try {
    const cookies = await getSetting("yt_cookies", null);
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

  const cookiePath = await getCookiesPath();
  const args = [
    url,
    "--dump-json",
    "--no-playlist",
    "--extractor-args", "youtube:player_client=android_vr,web_embedded;skip=dash,hls"
  ];
  if (cookiePath) args.push("--cookies", cookiePath);

  return new Promise((resolve, reject) => {
    let output = "";
    const proc = spawn(getYtDlpPath(), args);
    
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Media info fetch timed out (15s)"));
    }, 15000);

    proc.stdout.on("data", d => { output += d.toString(); });
    proc.on("close", async (code) => {
      clearTimeout(timeout);
      if (cookiePath) await fsPromises.unlink(cookiePath).catch(() => {});
      if (code !== 0) return reject(new Error(`Could not fetch media info.`));
      try {
        const info = JSON.parse(output);
        resolve({
          platform: info.extractor_key || platform,
          title:    info.title || `${platform} video`,
          thumbnail: info.thumbnail || null,
          duration:  info.duration || null,
          useYtDlp: true,
        });
      } catch { reject(new Error("Failed to parse media info.")); }
    });
    proc.on("error", reject);
  });
}

// ─── Core stream-based downloader ────────────────────────────────────────────

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
    "--extractor-args", "youtube:player_client=android_vr,web_embedded;skip=dash,hls",
    "--print", "after_move:filepath",
  ];

  if (cookiePath) args.push("--cookies", cookiePath);

  if (audioOnly) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", `${tmpBase}.mp3`);
  } else {
    // Instagram/Pinterest: use "best" — image posts have no vcodec attributes
    // Other platforms: prefer H.264 for iPhone compatibility
    const isImagePlatform = platform === "instagram" || platform === "pinterest";
    const format = isImagePlatform
      ? "best"
      // Prefer pre-muxed mp4 first (no re-encoding needed = fast)
      // Fall back to separate streams only if needed
      : `best[ext=mp4][height<=${quality}]/bestvideo[height<=${quality}][vcodec^=avc]+bestaudio[acodec^=mp4a]/best[height<=${quality}]/best`;

    args.push("-f", format, "-o", `${tmpBase}.%(ext)s`);

    // Only apply video post-processing for video platforms
    if (!isImagePlatform) {
      args.push(
        "--merge-output-format", "mp4",
        "--postprocessor-args", "ffmpeg:-movflags +faststart"
      );
    }
  }

  return heavyQueue.execute(() => new Promise((resolve, reject) => {
    const proc = spawn(getYtDlpPath(), args);
    let errorLog  = "";
    let finalPath = "";

    proc.stdout.on("data", d => { finalPath = d.toString().trim(); });
    proc.stderr.on("data", d => { errorLog += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Download timed out (3 mins)"));
    }, 180000);

    proc.on("close", async (code) => {
      clearTimeout(timeout);
      if (cookiePath) await fsPromises.unlink(cookiePath).catch(() => {});

      if (code !== 0) {
        const errorLines = errorLog.trim().split("\n");
        const mainError = errorLines.find(line => line.includes("ERROR:")) || errorLines[errorLines.length - 1] || "Unknown error";
        return reject(new Error(`yt-dlp failed: ${mainError.slice(0, 250)}`));
      }

      try {
        // Fallback: scan directory if --print didn't give us a path
        if (!finalPath || !existsSync(finalPath)) {
          const dir    = dirname(tmpBase);
          const prefix = basename(tmpBase);
          const files  = (await fsPromises.readdir(dir)).filter(f => f.startsWith(prefix));
          if (files.length === 0) throw new Error("yt-dlp produced no output file.");
          finalPath = join(dir, files[0]);
        }

        const buffer = await fsPromises.readFile(finalPath);
        await fsPromises.unlink(finalPath).catch(() => {});

        const ext = finalPath.split(".").pop().toLowerCase();
        const mimeTypes = {
          mp3: "audio/mpeg",
          mp4: "video/mp4",
          jpg: "image/jpeg", jpeg: "image/jpeg",
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
  }));
}

// ─── Legacy YouTube buffer export (used by mp3.js, sticker.js etc) ───────────
export const downloadYouTubeToBuffer = (url, audioOnly) => downloadWithYtDlp(url, audioOnly);

// ─── RapidAPI fallback ────────────────────────────────────────────────────────

async function getApiKey() {
  const key = await getSetting("rapidapi_key", null);
  if (!key?.trim()) throw new Error("RapidAPI key not set. Use !setapikey <key> to set it.");
  return key.trim();
}

async function getTikTokMediaApi(url, apiKey) {
  const res = await fetch(
    `https://tiktok-video-no-watermark2.p.rapidapi.com/?url=${encodeURIComponent(url)}&hd=1`,
    { headers: { "x-rapidapi-host": "tiktok-video-no-watermark2.p.rapidapi.com", "x-rapidapi-key": apiKey } }
  );
  if (!res.ok) throw new Error(`TikTok API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || "TikTok API failed.");
  const videoUrl = data.data?.play || data.data?.hdplay;
  if (!videoUrl) throw new Error("No downloadable video found.");
  return { title: data.data?.title || "TikTok Video", videoUrl, platform: "TikTok" };
}

async function getGenericMediaApi(url, platform, apiKey) {
  const res = await fetch(
    `https://all-social-media-video-downloader.p.rapidapi.com/smvd/get/all?url=${encodeURIComponent(url)}`,
    { headers: { "x-rapidapi-host": "all-social-media-video-downloader.p.rapidapi.com", "x-rapidapi-key": apiKey } }
  );
  if (!res.ok) throw new Error(`${platform} API error: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.message || "API failed.");
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

  if (!info.videoUrl) throw new Error("No downloadable link found.");

  const res = await fetch(info.videoUrl, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: "video/mp4", title: info.title, platform: info.platform };
}

// ─── Generic buffer download ──────────────────────────────────────────────────
export async function downloadToBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "" };
}

// ─── Image Search ─────────────────────────────────────────────────────────────

const IMAGE_SEARCH_TIMEOUT = 15_000;
const IMAGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Search Bing images and return direct image URLs
export async function searchImages(query, count = 3) {
  const params = new URLSearchParams({ q: query, form: "HDRSC2" });
  
  const res = await fetch(`https://www.bing.com/images/search?${params}`, {
    headers: { "User-Agent": IMAGE_USER_AGENT },
    signal: AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT),
  });

  if (!res.ok) throw new Error(`Bing image search failed: ${res.status}`);

  const html = await res.text();
  const results = [...html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)].map(m => m[1]);

  // Return direct image URLs — filter out SVGs, tiny icons, and non-http
  return results
    .filter(url =>
      url &&
      url.startsWith("http") &&
      !url.endsWith(".svg") &&
      !url.endsWith(".gif") &&
      !url.includes("logo") &&
      !url.includes("icon")
    )
    .slice(0, count);
}

// Download a single image URL to a buffer
export async function downloadImageUrl(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": IMAGE_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Not an image: ${contentType}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Reject tracking pixels and placeholder images
  if (buffer.length < 5000) throw new Error("Image too small (likely a placeholder)");

  return { buffer, contentType };
}
