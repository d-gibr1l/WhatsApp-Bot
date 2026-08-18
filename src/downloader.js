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
    exec(`pip install --upgrade --break-system-packages yt-dlp bgutil-ytdlp-pot-provider`, (err) => {
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

  const cookiePath = await getCookiesPath();
  
  const args = [
    url,
    "--dump-json",
    "--no-playlist"
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
    "--force-ipv4",
    "--concurrent-fragments", "10",
    "--downloader", "aria2c,native",
    "--downloader-args", "aria2c:-x 16 -k 1M",
    "--ffmpeg-location", process.env.FFMPEG_PATH || "ffmpeg",
    "--print", "%(title)s",
    "--print", "after_move:filepath",
  ];

  if (cookiePath) args.push("--cookies", cookiePath);

  if (process.env.RENDER || process.env.KOYEB || existsSync("./wireproxy")) {
    args.push("--proxy", "socks5://127.0.0.1:1080");
  }

  const maxFilesize = (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY) ? "100M" : "50M";

  if (audioOnly) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", `${tmpBase}.mp3`);
  } else {
    const isImagePlatform = platform === "instagram" || platform === "pinterest";
    
    // Explicitly demand an mp4 video track, with safe fallback formats
    const format = isImagePlatform
      ? "best"
      : `bestvideo[ext=mp4][height<=${quality}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${quality}]/best`;

    args.push("-f", format, "-o", `${tmpBase}.%(ext)s`);

    if (!isImagePlatform) {
      args.push("--merge-output-format", "mp4");
    }
  }

  return heavyQueue.execute(() => new Promise((resolve, reject) => {
    const proc = spawn(getYtDlpPath(), args, {
      env: { ...process.env, PATH: `${process.cwd()}:${process.env.PATH}` }
    });
    let errorLog  = "";
    let stdoutOut = "";

    proc.stdout.on("data", d => { stdoutOut += d.toString(); });
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
        const outputLines = stdoutOut.trim().split("\n").map(l => l.trim()).filter(Boolean);
        let title = "Video";
        let finalPath = "";

        if (outputLines.length > 0) {
          title = outputLines[0];
          if (outputLines.length > 1) {
            finalPath = outputLines[outputLines.length - 1];
          }
        }

        // FIX 2: Advanced Fallback Sorter
        if (!finalPath || !existsSync(finalPath)) {
          const dir    = dirname(tmpBase);
          const prefix = basename(tmpBase);
          const files  = (await fsPromises.readdir(dir)).filter(f => f.startsWith(prefix));
          
          if (files.length === 0) throw new Error("yt-dlp produced no output file.");
          
          // Force it to pick the video file over the audio file if ffmpeg failed to merge them
          files.sort((a, b) => {
            const isVideoA = a.match(/\.(mp4|mkv|webm)$/i) ? -1 : 1;
            const isVideoB = b.match(/\.(mp4|mkv|webm)$/i) ? -1 : 1;
            return isVideoA - isVideoB;
          });
          
          finalPath = join(dir, files[0]);
        }

        const ext = finalPath.split(".").pop().toLowerCase();
        const mimeTypes = {
          mp3: "audio/mpeg",
          mp4: "video/mp4",
          jpg: "image/jpeg", jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        };

        const contentType = mimeTypes[ext] || "video/mp4";

        if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_BUCKET_NAME) {
          try {
            const s3Client = new S3Client({
              region: "auto",
              endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
              credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY,
                secretAccessKey: process.env.R2_SECRET_KEY,
              },
            });

            const fileStream = createReadStream(finalPath);
            const uploadParams = {
              Bucket: process.env.R2_BUCKET_NAME,
              Key: `downloads/${Date.now()}_${basename(finalPath)}`,
              Body: fileStream,
              ContentType: contentType,
            };

            const uploader = new Upload({
              client: s3Client,
              params: uploadParams,
            });

            await uploader.done();
            await fsPromises.unlink(finalPath).catch(() => {});

            const publicUrl = process.env.R2_PUBLIC_URL 
              ? `${process.env.R2_PUBLIC_URL}/${uploadParams.Key}` 
              : `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${uploadParams.Key}`;

            return resolve({ filePath: null, url: publicUrl, contentType, title });
          } catch (uploadErr) {
            console.error("[Downloader] R2 Upload failed:", uploadErr);
          }
        }

        return resolve({ filePath: finalPath, url: null, contentType, title });
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", reject);
  }));
}

// ─── Legacy YouTube buffer export ────────────────────────────────────────────
export const downloadYouTubeToBuffer = async (url, audioOnly) => {
  const { filePath } = await downloadWithYtDlp(url, audioOnly);
  const buffer = await fsPromises.readFile(filePath);
  await fsPromises.unlink(filePath).catch(() => {});
  return buffer;
};

// ─── RapidAPI fallback ────────────────────────────────────────────────────────

async function getApiKey() {
  const key = await db.getSetting("rapidapi_key", null);
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
  
  const tmpBase = join(tmpdir(), `api_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const fileStream = createWriteStream(tmpBase);
  await pipeline(Readable.fromWeb(res.body), fileStream);
  
  return { filePath: tmpBase, contentType: "video/mp4", title: info.title, platform: info.platform };
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

export async function searchImages(query, count = 3) {
  try {
    const homeRes = await fetch("https://www.pinterest.com/");
    const cookies = homeRes.headers.get("set-cookie") || "";

    const endpoint = "https://www.pinterest.com/resource/BaseSearchResource/get/";
    const options = {
      appliedProductFilters: "---",
      auto_correction_disabled: false,
      bookmarks: [""],
      page_size: count + 5,
      query: query,
      redux_normalize_feed: true,
      rs: "typed",
      scope: "pins",
      source_url: `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`,
    };

    const urlQuery = new URLSearchParams({
      source_url: options.source_url,
      data: JSON.stringify({ options, context: {} }),
      _: Date.now()
    }).toString();

    const res = await fetch(`${endpoint}?${urlQuery}`, {
      headers: {
        "User-Agent": IMAGE_USER_AGENT,
        "x-pinterest-pws-handler": "www/search/pins/?q=[q]&rs=[rs].js",
        "Cookie": cookies
      },
      signal: AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT),
    });

    if (!res.ok) throw new Error(`Pinterest search failed: ${res.status}`);

    const data = await res.json();
    if (data.resource_response?.error) {
      throw new Error(`Pinterest API error: ${data.resource_response.error.message}`);
    }

    const results = data.resource_response?.data?.results || [];
    const imageUrls = results
      .map(pin => pin.images?.orig?.url || pin.images?.originals?.url)
      .filter(url => url && url.startsWith("http"));

    return imageUrls.slice(0, count);
  } catch (err) {
    throw new Error(`Pinterest search failed: ${err.message}`);
  }
}

export async function downloadImageUrl(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": IMAGE_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    throw new Error(`Not an image or video: ${contentType}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length < 5000) throw new Error("Image too small (likely a placeholder)");

  return { buffer, contentType };
}

// ─── GIF Search (Tenor API) ───────────────────────────────────────────────────

export async function searchGifs(query, limit = 5) {
  try {
    const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=LIVDSRZULELA&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tenor API error: ${res.status}`);
    const data = await res.json();
    
    if (!data.results || data.results.length === 0) return [];
    
    return data.results.map(r => {
      const media = r.media[0];
      return media.mp4 ? media.mp4.url : media.gif.url;
    });
  } catch (err) {
    console.error("Tenor API Error:", err.message);
    return [];
  }
}
