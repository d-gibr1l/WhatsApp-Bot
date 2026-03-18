import { execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
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
  // Use a template path — yt-dlp will set the real extension
  const tmpBase = join(tmpdir(), `ytdlp_${Date.now()}`);
  const outTemplate = `${tmpBase}.%(ext)s`;

  try {
    if (audioOnly) {
      execSync(
        `yt-dlp -x --audio-format mp3 --audio-quality 0 ${cookiesFlag} -o "${tmpBase}.mp3" "${url}"`,
        { timeout: 120000 }
      );
      const outPath = `${tmpBase}.mp3`;
      if (!existsSync(outPath)) throw new Error("yt-dlp produced no output file.");
      const buffer = readFileSync(outPath);
      try { unlinkSync(outPath); } catch {}
      return { buffer, contentType: "audio/mpeg" };
    }

    // Try simple download first (works for images and some platforms)
    // Fall back to video-specific format filter if that fails
    let downloadSucceeded = false;
    try {
      execSync(
        `yt-dlp --no-playlist ${cookiesFlag} -o "${outTemplate}" "${url}"`,
        { timeout: 60000 }
      );
      downloadSucceeded = true;
    } catch {}

    if (!downloadSucceeded) {
      // Video fallback — force H.264 + AAC for iPhone compatibility
      const heightFilter = quality === "best" ? "" : `[height<=${quality}]`;
      execSync(
        `yt-dlp -f "bestvideo${heightFilter}[vcodec^=avc][ext=mp4]+bestaudio[ext=m4a]/bestvideo${heightFilter}[ext=mp4]+bestaudio[ext=m4a]/best${heightFilter}[ext=mp4]/best${heightFilter}" --merge-output-format mp4 --postprocessor-args "ffmpeg:-c:v libx264 -c:a aac -movflags +faststart" ${cookiesFlag} -o "${outTemplate}" "${url}"`,
        { timeout: 180000 }
      );
    }

    // Find what file was actually written
    const { readdirSync } = await import("fs");
    const tmpDir = dirname(tmpBase);
    const base   = basename(tmpBase);
    const files  = readdirSync(tmpDir).filter(f => f.startsWith(base));

    if (files.length === 0) throw new Error("yt-dlp produced no output file.");

    const outFile = join(tmpDir, files[0]);
    const ext     = files[0].split(".").pop().toLowerCase();
    const buffer  = readFileSync(outFile);
    try { unlinkSync(outFile); } catch {}

    // Detect content type from extension
    const imageExts = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
    const audioExts = ["mp3", "m4a", "ogg", "flac", "wav"];
    let contentType = "video/mp4";
    if (imageExts.includes(ext)) contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;
    else if (audioExts.includes(ext)) contentType = `audio/${ext}`;

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
