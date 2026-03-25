import { spawn } from "child_process";
import { promises as fsPromises, existsSync, readdirSync } from "fs";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { getSetting } from "./db.js";

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

async function getCookiesPath() {
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
  const args = [url, "--dump-json", "--no-playlist"];
  if (cookiePath) args.push("--cookies", cookiePath);

  return new Promise((resolve, reject) => {
    let output = "";
    const proc = spawn("yt-dlp", args);
    proc.stdout.on("data", d => { output += d.toString(); });
    proc.on("close", async (code) => {
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
  const tmpBase    = join(tmpdir(), `ytdlp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const userAgent  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

  let args = [url, "--user-agent", userAgent, "--no-playlist"];
  if (cookiePath) args.push("--cookies", cookiePath);

  if (audioOnly) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", `${tmpBase}.mp3`);
  } else {
    const height = quality === "best" ? "" : `[height<=${quality}]`;
    args.push(
      "-f", `bestvideo${height}[vcodec^=avc]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best`,
      "--merge-output-format", "mp4",
      "--postprocessor-args", "ffmpeg:-c:v libx264 -pix_fmt yuv420p -profile:v main -level 3.1 -c:a aac -movflags +faststart",
      "-o", `${tmpBase}.%(ext)s`
    );
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args);

    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });

    proc.on("close", async (code) => {
      if (cookiePath) await fsPromises.unlink(cookiePath).catch(() => {});

      if (code !== 0) {
        return reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(-200)}`));
      }

      try {
        const tmpDir   = dirname(tmpBase);
        const baseName = basename(tmpBase);
        const files    = (await fsPromises.readdir(tmpDir)).filter(f => f.startsWith(baseName));
        if (files.length === 0) throw new Error("yt-dlp produced no output file.");

        const finalPath = join(tmpDir, files[0]);
        const ext       = files[0].split(".").pop().toLowerCase();
        const buffer    = await fsPromises.readFile(finalPath);
        await fsPromises.unlink(finalPath).catch(() => {});

        let contentType = "video/mp4";
        if (ext === "mp3")                         contentType = "audio/mpeg";
        if (["jpg","jpeg","png","webp"].includes(ext)) contentType = "image/jpeg";

        resolve({ buffer, contentType });
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", reject);
  });
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
    `https://social-media-video-downloader.p.rapidapi.com/smvd/get/all?url=${encodeURIComponent(url)}`,
    { headers: { "x-rapidapi-host": "social-media-video-downloader.p.rapidapi.com", "x-rapidapi-key": apiKey } }
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
