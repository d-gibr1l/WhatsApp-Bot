const fs = require('fs');
let code = fs.readFileSync('src/downloader.js', 'utf8');

const newFunctions = 
function extractYouTubeId(url) {
  if (!url) return null;
  if (url.startsWith('ytsearch')) return null;
  const match = url.match(/(?:youtu\\.be\\/|youtube\\.com\\/(?:[^\\/]+\\/.+\\/|(?:v|e(?:mbed)?)\\/|.*[?&]v=)|shorts\\/)([^\"&?\\/\\s]{11})/);
  return match ? match[1] : null;
}

async function downloadGenericApiFile(videoUrl, title, platform) {
  const res = await fetch(videoUrl, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(\Failed to download API link: \\);
  const tmpBase = join(tmpdir(), \pi_dl_\_\.mp4\);
  const fileStream = createWriteStream(tmpBase);
  await pipeline(Readable.fromWeb(res.body), fileStream);
  return { filePath: tmpBase, contentType: "video/mp4", title: title || \\ Video\ };
}

async function downloadYouTubeApiChain(url, audioOnly) {
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error("Could not extract YouTube video ID.");
  const apiKey = await getApiKey();

  // API 1: all-media-downloader4
  try {
    const res = await fetch(\https://all-media-downloader4.p.rapidapi.com/api/youtube/download?id=\\, {
      headers: { "x-rapidapi-host": "all-media-downloader4.p.rapidapi.com", "x-rapidapi-key": apiKey }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status === "ok" && data.results && data.results.length > 0) {
        let bestFormat;
        if (audioOnly) bestFormat = data.results.find(f => f.has_audio && !f.mime.includes("video")) || data.results.find(f => f.has_audio);
        else bestFormat = data.results.find(f => f.quality === "720p" && f.has_audio) || data.results.find(f => f.quality === "720p") || data.results.find(f => f.mime.includes("video"));
        if (bestFormat && bestFormat.url) {
          console.log("[Downloader] YouTube Downloaded via API 1 (all-media-downloader4)");
          return await downloadGenericApiFile(bestFormat.url, data.title, "YouTube");
        }
      }
    }
  } catch (e) { console.log("[Downloader] API 1 failed..."); }

  // API 2: social-media-video-downloader
  try {
    const res = await fetch(\https://social-media-video-downloader.p.rapidapi.com/youtube/v3/video/details?videoId=\&urlAccess=proxied&renderableFormats=720p,highres&getTranscript=false\, {
      headers: { "x-rapidapi-host": "social-media-video-downloader.p.rapidapi.com", "x-rapidapi-key": apiKey }
    });
    if (res.ok) {
      const data = await res.json();
      const videos = data.contents?.[0]?.videos || [];
      const audios = data.contents?.[0]?.audios || [];
      let targetUrl = audioOnly ? (audios[0]?.url || videos[0]?.url) : (videos.find(v => v.label === "720p")?.url || videos.find(v => v.label === "1080p")?.url || videos[0]?.url);
      if (targetUrl) {
        console.log("[Downloader] YouTube Downloaded via API 2 (social-media-video-downloader)");
        return await downloadGenericApiFile(targetUrl, data.contents?.[0]?.title, "YouTube");
      }
    }
  } catch (e) { console.log("[Downloader] API 2 failed..."); }

  // API 3: youtube-info-download-api
  try {
    const res = await fetch(\https://youtube-info-download-api.p.rapidapi.com/ajax/download.php?format=\&url=\\, {
      headers: { "x-rapidapi-host": "youtube-info-download-api.p.rapidapi.com", "x-rapidapi-key": apiKey }
    });
    if (res.ok) {
      const initial = await res.json();
      if (initial.progress_url) {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const pollRes = await fetch(initial.progress_url);
          if (pollRes.ok) {
            const poll = await pollRes.json();
            if (poll.download_url || poll.url) {
              console.log("[Downloader] YouTube Downloaded via API 3 (youtube-info-download-api)");
              return await downloadGenericApiFile(poll.download_url || poll.url, poll.title || initial.title, "YouTube");
            }
          }
        }
      }
    }
  } catch (e) { console.log("[Downloader] API 3 failed..."); }

  // API 4: all-in-one-social-media-saver-api
  try {
    const res = await fetch(\https://all-in-one-social-media-saver-api.p.rapidapi.com/smvd/get/all?url=\\, {
      headers: { "x-rapidapi-host": "all-in-one-social-media-saver-api.p.rapidapi.com", "x-rapidapi-key": apiKey }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.url) {
        console.log("[Downloader] YouTube Downloaded via API 4 (all-in-one-social-media-saver-api)");
        return await downloadGenericApiFile(data.url, data.title, "YouTube");
      }
    }
  } catch (e) { console.log("[Downloader] API 4 failed."); }

  throw new Error("All YouTube APIs failed.");
}
;

code = code.replace('export async function downloadWithYtDlp(url, audioOnly = false, quality = "720") {', newFunctions + '\nexport async function downloadWithYtDlp(url, audioOnly = false, quality = "720") {');

const ytApiLogic = 
  if (platform === "youtube") {
    const result = await downloadYouTubeApiChain(url, audioOnly);
    if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_BUCKET_NAME) {
      try {
        const s3Client = new S3Client({
          region: "auto",
          endpoint: \https://\.r2.cloudflarestorage.com\,
          credentials: { accessKeyId: process.env.R2_ACCESS_KEY, secretAccessKey: process.env.R2_SECRET_KEY },
        });

        const fileStream = createReadStream(result.filePath);
        const uploadParams = {
          Bucket: process.env.R2_BUCKET_NAME,
          Key: \downloads/\_\\,
          Body: fileStream,
          ContentType: result.contentType,
        };

        const uploader = new Upload({ client: s3Client, params: uploadParams });
        await uploader.done();
        await fsPromises.unlink(result.filePath).catch(() => {});

        const publicUrl = process.env.R2_PUBLIC_URL 
          ? \\/\\ 
          : \https://\.\.r2.cloudflarestorage.com/\\;

        return { filePath: null, url: publicUrl, contentType: result.contentType, title: result.title };
      } catch (uploadErr) {
        console.error("[Downloader] R2 Upload failed:", uploadErr);
      }
    }
    return { filePath: result.filePath, url: null, contentType: result.contentType, title: result.title };
  }
;

code = code.replace(/export async function downloadWithYtDlp\(url, audioOnly = false, quality = "720"\) \{\n  const platform = detectPlatform\(url\);\n/, 
  'export async function downloadWithYtDlp(url, audioOnly = false, quality = "720") {\n  const platform = detectPlatform(url);\n' + ytApiLogic);

// Also we need to make sure getMediaInfo doesn't use yt-dlp for youtube!
const getMediaInfoYtLogic = 
  if (platform === "youtube") {
    try {
      const apiKey = await getApiKey();
      const videoId = extractYouTubeId(url);
      if (videoId) {
        const res = await fetch(\https://social-media-video-downloader.p.rapidapi.com/youtube/v3/video/details?videoId=\&urlAccess=proxied&renderableFormats=360p&getTranscript=false\, {
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
              platform: "youtube"
            };
          }
        }
      }
    } catch (e) {}
  }
;

code = code.replace(/export async function getMediaInfo\(url\) \{\n  const platform = detectPlatform\(url\);\n  if \(!platform\) throw new Error\("Unsupported platform."\);\n/,
  'export async function getMediaInfo(url) {\n  const platform = detectPlatform(url);\n  if (!platform) throw new Error("Unsupported platform.");\n' + getMediaInfoYtLogic);


fs.writeFileSync('src/downloader.js', code);
