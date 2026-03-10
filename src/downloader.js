import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSetting } from "./db.js";

// ─── Platform Detection ───────────────────────────────────────────────────────

export function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url))   return "youtube";
  if (/tiktok\.com/.test(url))              return "tiktok";
  if (/instagram\.com/.test(url))           return "instagram";
  if (/twitter\.com|x\.com/.test(url))      return "twitter";
  if (/facebook\.com|fb\.watch/.test(url))  return "facebook";
  return null;
}

export function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

// Fetch RapidAPI key for non-YouTube platforms
async function getApiKey() {
  const key = await getSetting("rapidapi_key", null);
  if (!key || key.trim() === "") {
    throw new Error("RapidAPI key is not set. Admin can set it with: !setapikey <key>");
  }
  return key.trim();
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

export async function getMediaInfo(url) {
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Unsupported platform. Supported: YouTube, TikTok, Instagram, Twitter/X, Facebook");

  if (platform === "youtube") return getYouTubeMedia(url);

  const apiKey = await getApiKey();
  if (platform === "tiktok") return getTikTokMedia(url, apiKey);
  return getGenericMedia(url, platform, apiKey);
}

// ─── YouTube via yt-dlp ───────────────────────────────────────────────────────

async function getCookiesArg() {
  try {
    const cookies = await getSetting("yt_cookies", null);
    if (!cookies) return "";
    const cookiePath = join(tmpdir(), "yt_cookies.txt");
    writeFileSync(cookiePath, cookies);
    return `--cookies "${cookiePath}"`;
  } catch {
    return "";
  }
}

async function getYouTubeMedia(url) {
  try {
    const cookiesArg = await getCookiesArg();
    // Get video info as JSON
    const infoJson = execSync(
      `yt-dlp --dump-json --no-playlist ${cookiesArg} "${url}"`,
      { timeout: 30000, encoding: "utf8" }
    );
    const info = JSON.parse(infoJson);

    return {
      platform: "YouTube",
      title: info.title || "YouTube Video",
      thumbnail: info.thumbnail || null,
      videoUrl: url,   // We pass the original URL — downloadYouTube handles the actual download
      audioUrl: null,
      quality: "720p",
      useYtDlp: true,  // Flag to tell commands/downloader.js to use yt-dlp download
      duration: info.duration,
    };
  } catch (err) {
    throw new Error(`Could not fetch YouTube video info: ${err.message}`);
  }
}

// ─── YouTube direct download via yt-dlp ──────────────────────────────────────

export async function downloadYouTubeToBuffer(url, audioOnly = false) {
  const outPath = join(tmpdir(), `ytdlp_${Date.now()}.${audioOnly ? "mp3" : "mp4"}`);

  const cookiesArg = await getCookiesArg();
  try {
    if (audioOnly) {
      execSync(
        `yt-dlp -x --audio-format mp3 --audio-quality 0 ${cookiesArg} -o "${outPath}" "${url}"`,
        { timeout: 120000 }
      );
    } else {
      execSync(
        `yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]" --merge-output-format mp4 ${cookiesArg} -o "${outPath}" "${url}"`,
        { timeout: 120000 }
      );
    }

    if (!existsSync(outPath)) throw new Error("yt-dlp did not produce output file.");

    const buffer = readFileSync(outPath);
    unlinkSync(outPath);

    return {
      buffer,
      contentType: audioOnly ? "audio/mpeg" : "video/mp4",
    };
  } catch (err) {
    try { if (existsSync(outPath)) unlinkSync(outPath); } catch {}
    throw new Error(`YouTube download failed: ${err.message}`);
  }
}

// ─── TikTok ───────────────────────────────────────────────────────────────────

async function getTikTokMedia(url, apiKey) {
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
  if (data.code !== 0) throw new Error(data.msg || "TikTok download failed.");

  const videoUrl = data.data?.play || data.data?.hdplay || null;
  const audioUrl = data.data?.music || null;

  if (!videoUrl && !audioUrl) throw new Error("No downloadable media found for this TikTok.");

  return {
    platform: "TikTok",
    title: data.data?.title || "TikTok Video",
    thumbnail: data.data?.cover || null,
    videoUrl,
    audioUrl,
    quality: "HD",
  };
}

// ─── Instagram / Twitter / Facebook ──────────────────────────────────────────

async function getGenericMedia(url, platform, apiKey) {
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
  if (!data.success) throw new Error(data.message || "Could not fetch media.");

  const links = data.links || [];
  const videoLink =
    links.find((l) => l.quality === "720" || l.quality === "720p") ||
    links.find((l) => parseInt(l.quality) <= 720 && l.link?.includes("video")) ||
    links.find((l) => l.link?.includes("video")) ||
    links[0];

  return {
    platform: platform.charAt(0).toUpperCase() + platform.slice(1),
    title: data.title || `${platform} Video`,
    thumbnail: data.picture || null,
    videoUrl: videoLink?.link || null,
    audioUrl: null,
    quality: videoLink?.quality || "unknown",
  };
}

// ─── Download Buffer (for non-YouTube platforms) ──────────────────────────────

export async function downloadToBuffer(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`Failed to download media: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  const buffer = Buffer.from(await res.arrayBuffer());

  return { buffer, contentType };
}
