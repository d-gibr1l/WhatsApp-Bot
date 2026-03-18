import { execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises, existsSync, readdirSync } from "fs";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
const execAsync = promisify(exec);
import { getSetting } from "./db.js";

// ─── Platform Detection ───────────────────────────────────────────────────────

export function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url))  return "youtube";
  if (/tiktok\.com/.test(url))             return "tiktok";
  if (/instagram\.com/.test(url))          return "instagram";
  if (/twitter\.com|x\.com/.test(url))     return "twitter";
  if (/facebook\.com|fb\.watch/.test(url)) return "facebook";
  if (/pinterest\.com|pin\.it/.test(url))  return "pinterest";
  if (/vimeo\.com/.test(url))              return "vimeo";
  if (/dailymotion\.com/.test(url))        return "dailymotion";
  if (/reddit\.com/.test(url))             return "reddit";
  if (/twitch\.tv/.test(url))              return "twitch";
  return null;
}

export function extractUrl(text) {
  const match = text?.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

// ─── Cookies Helper ───────────────────────────────────────────────────────────

async function getCookiesFlag() {
  try {
    const cookies = await getSetting("yt_cookies", null);
    if (!cookies || cookies.trim() === "") return "";
    const cookiePath = join(tmpdir(), "yt_cookies.txt");
    writeFileSync(cookiePath, cookies);
    return `--cookies "${cookiePath}"`;
  } catch {
    return "";
  }
}

// ─── yt-dlp info fetch ────────────────────────────────────────────────────────

export async function getMediaInfo(url) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported link.");

  const cookiesFlag = await getCookiesFlag();
  try {
    const infoJson = execSync(
      `yt-dlp --dump-json --no-playlist ${cookiesFlag} "${url}"`,
      { timeout: 30000, encoding: "utf8" }
    );
    const info = JSON.parse(infoJson);
    return {
      platform: info.extractor_key || platform,
      title: info.title || `${platform} video`,
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      useYtDlp: true,
    };
  } catch (err) {
    throw new Error(`Could not fetch media info: ${err.message?.slice(0, 120)}`);
  }
}

// ─── yt-dlp download ──────────────────────────────────────────────────────────

export async function downloadWithYtDlp(url, audioOnly = false, quality = "720") {
  const cookiesFlag = await getCookiesFlag();
  const tmpBase = join(tmpdir(), `ytdlp_${Date.now()}`);
  const outTemplate = `${tmpBase}.%(ext)s`;

  // Mobile User Agent helps with Instagram/TikTok
  const userAgent = `"Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"`;

  try {
    let cmd = "";

    if (audioOnly) {
      cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 ${cookiesFlag} --user-agent ${userAgent} -o "${tmpBase}.mp3" "${url}"`;
    } else {
      const height = quality === "best" ? "" : `[height<=${quality}]`;
      cmd = `yt-dlp -f "bestvideo${height}[vcodec^=avc]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best" ` +
            `--merge-output-format mp4 ` +
            `--user-agent ${userAgent} ` +
            `${cookiesFlag} ` +
            `--postprocessor-args "ffmpeg:-c:v libx264 -pix_fmt yuv420p -profile:v main -level 3.1 -c:a aac -movflags +faststart" ` +
            `-o "${outTemplate}" "${url}"`;
    }

    await execAsync(cmd, { timeout: 300000 });

    // Find what file yt-dlp actually wrote
    const tmpDir  = dirname(tmpBase);
    const baseName = basename(tmpBase);
    const files   = readdirSync(tmpDir).filter(f => f.startsWith(baseName));
    if (files.length === 0) throw new Error("File not found after download.");

    const finalPath = join(tmpDir, files[0]);
    const buffer    = await fsPromises.readFile(finalPath);
    const ext       = files[0].split(".").pop().toLowerCase();
    await fsPromises.unlink(finalPath).catch(() => {});

    let contentType = "video/mp4";
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) contentType = "image/jpeg";
    if (ext === "mp3") contentType = "audio/mpeg";

    return { buffer, contentType };
  } catch (err) {
    throw new Error(`Download failed: ${err.message?.slice(0, 200)}`);
  }
}

// ─── Legacy API-based download (used by !dlapi command) ───────────────────────

async function getApiKey() {
  const key = await getSetting("rapidapi_key", null);
  if (!key || key.trim() === "") {
    throw new Error("RapidAPI key not set. Use !setapikey <key> to set it.");
  }
  return key.trim();
}

async function getTikTokMediaApi(url, apiKey) {
  const res = await fetch(
    `https://tiktok-video-no-watermark2.p.rapidapi.com/?url=${encodeURIComponent(url)}&hd=1`,
    {
      headers: {
        "x-rapidapi-host": "tiktok-video-no-watermark2.p.rapidapi.com",
        "x-rapidapi-key": apiKey,
      },
    }
  );
  if (!res.ok) throw new Error(`TikTok API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(data.msg || "TikTok API download failed.");
  const videoUrl = data.data?.play || data.data?.hdplay || null;
  if (!videoUrl) throw new Error("No downloadable video found.");
  return { title: data.data?.title || "TikTok Video", videoUrl, platform: "TikTok" };
}

async function getGenericMediaApi(url, platform, apiKey) {
  const res = await fetch(
    `https://social-media-video-downloader.p.rapidapi.com/smvd/get/all?url=${encodeURIComponent(url)}`,
    {
      headers: {
        "x-rapidapi-host": "social-media-video-downloader.p.rapidapi.com",
        "x-rapidapi-key": apiKey,
      },
    }
  );
  if (!res.ok) throw new Error(`${platform} API error: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.message || "API download failed.");
  const links = data.links || [];
  const best = links.find(l => l.quality === "720" || l.quality === "720p") || links[0];
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

  const res = await fetch(info.videoUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: "video/mp4", title: info.title, platform: info.platform };
}

// Keep legacy exports for backward compat
export const downloadYouTubeToBuffer = (url, audioOnly) => downloadWithYtDlp(url, audioOnly);
export async function downloadToBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "" };
}