import { spawn, exec } from "child_process";
import { promises as fsPromises, existsSync, createWriteStream } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
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
    "--force-ipv4",
    "--concurrent-fragments", "10",
    "--downloader", "aria2c,native",
    "--downloader-args", "aria2c:-x 16 -k 1M",
    "--extractor-args", "youtube:player_client=android_vr,web_embedded;skip=dash,hls",
    "--print", "%(title)s",
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
      args.push("--merge-output-format", "mp4");
    }
  }

  return heavyQueue.execute(() => new Promise((resolve, reject) => {
    const proc = spawn(getYtDlpPath(), args);
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

        if (!finalPath || !existsSync(finalPath)) {
          const dir    = dirname(tmpBase);
          const prefix = basename(tmpBase);
          const files  = (await fsPromises.readdir(dir)).filter(f => f.startsWith(prefix));
          if (files.length === 0) throw new Error("yt-dlp produced no output file.");
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

        return resolve({ filePath: finalPath, contentType: mimeTypes[ext] || "video/mp4", title });
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", reject);
  }));
}

// ─── Legacy YouTube buffer export (used by mp3.js, sticker.js etc) ───────────
export const downloadYouTubeToBuffer = async (url, audioOnly) => {
  const { filePath } = await downloadWithYtDlp(url, audioOnly);
  const buffer = await fsPromises.readFile(filePath);
  await fsPromises.unlink(filePath).catch(() => {});
// ─── RapidAPI fallback ────────────────────────────────────────────────────────

export async function getApiKey() {
  let key = await getSetting("rapidapi_key", null);
  if (!key) throw new Error("RapidAPI key not set");
  key = key.trim();
  if (key.includes(';')) key = key.split(';')[0];
  return key;
}

async function getYouTubeRapidApiCascade(url, apiKey) {
  const encoded = encodeURIComponent(url);
  const apis = [
    {
      // 1. All Media Downloader
      method: "POST",
      url: "https://all-media-downloader1.p.rapidapi.com/all",
      headers: { "x-rapidapi-host": "all-media-downloader1.p.rapidapi.com", "x-rapidapi-key": apiKey, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url })
    },
    {
      // 2. All-In-One Social Media Saver API
      method: "GET",
      url: `https://all-in-one-social-media-saver-api.p.rapidapi.com/fetch?url=${encoded}`,
      headers: { "x-rapidapi-host": "all-in-one-social-media-saver-api.p.rapidapi.com", "x-rapidapi-key": apiKey }
    },
    {
      // 3. social media video downloader (the original)
      method: "GET",
      url: `https://all-social-media-video-downloader.p.rapidapi.com/smvd/get/all?url=${encoded}`,
      headers: { "x-rapidapi-host": "all-social-media-video-downloader.p.rapidapi.com", "x-rapidapi-key": apiKey }
    },
    {
      // 4. YouTube Info & Download API
      method: "GET",
      url: `https://youtube-info-download-api.p.rapidapi.com/video?url=${encoded}`,
      headers: { "x-rapidapi-host": "youtube-info-download-api.p.rapidapi.com", "x-rapidapi-key": apiKey }
    }
  ];

  let lastError = null;

  for (const api of apis) {
    try {
      let res;
      if (api.method === "POST") {
        res = await fetch(api.url, { method: "POST", headers: api.headers, body: api.body });
      } else {
        res = await fetch(api.url, { method: "GET", headers: api.headers });
      }
      
      if (!res.ok) {
         lastError = `Status ${res.status}`;
         continue;
      }
      
      const data = await res.json();
      
      // Smart extractor for various RapidAPI response formats
      let videoUrl = null;
      let title = data.title || data.data?.title || "YouTube Video";
      
      if (data.download_url) videoUrl = data.download_url;
      else if (data.url) videoUrl = data.url;
      else if (data.video_url) videoUrl = data.video_url;
      else if (data.links && Array.isArray(data.links)) {
        const best = data.links.find(l => l.quality === "720" || l.quality === "720p") || data.links[0];
        videoUrl = best?.link || best?.url;
      }
      else if (data.formats && Array.isArray(data.formats)) {
        const best = data.formats.find(f => f.qualityLabel === "720p" || f.height === 720) || data.formats[0];
        videoUrl = best?.url || best?.link;
      }
      else if (data.data?.play || data.data?.hdplay) {
        videoUrl = data.data.hdplay || data.data.play;
      }
      
      if (videoUrl) {
         return { title, videoUrl, platform: "YouTube" };
      }
      lastError = "No valid video URL found in response";
    } catch (e) {
      lastError = e.message;
    }
  }
  
  throw new Error(`All 4 YouTube API fallbacks failed. Last error: ${lastError}`);
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

  let info;
  if (platform === "tiktok") {
    info = await getTikTokMediaApi(url, apiKey);
  } else if (platform === "youtube") {
    info = await getYouTubeRapidApiCascade(url, apiKey);
  } else {
    info = await getGenericMediaApi(url, platform, apiKey);
  }

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

// 🚀 SPEED OPTIMIZATION: Cache the cookie in RAM so we don't load the homepage every search
let cachedPinterestCookie = null;

export async function searchImages(query, count = 3) {
  try {
    // Only fetch a new cookie if we don't have one yet
    if (!cachedPinterestCookie) {
        const homeRes = await fetch("https://www.pinterest.com/");
        cachedPinterestCookie = homeRes.headers.get("set-cookie") || "";
    }

    const endpoint = "https://www.pinterest.com/resource/BaseSearchResource/get/";
    const options = {
      appliedProductFilters: "---",
      auto_correction_disabled: false,
      bookmarks: [""],
      page_size: count + 5, // fetch extras in case of dead links
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
        "Cookie": cachedPinterestCookie
      },
      signal: AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT),
    });

    // If Pinterest rejects the cached cookie, clear it so it refreshes next time
    if (res.status === 401 || res.status === 403) {
        cachedPinterestCookie = null;
        throw new Error("Pinterest session refreshed. Please try the command again.");
    }

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

// Download a single image URL to a buffer
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

  // Reject tracking pixels and placeholder images
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
    
    // Extract mp4 URL for better WhatsApp compatibility (smaller, auto-plays as gif)
    // or fallback to actual gif url
    return data.results.map(r => {
      const media = r.media[0];
      return media.mp4 ? media.mp4.url : media.gif.url;
    });
  } catch (err) {
    console.error("Tenor API Error:", err.message);
    return [];
  }
}
