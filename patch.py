
import re

with open("src/downloader.js", "r", encoding="utf-8") as f:
    code = f.read()

ytApiLogic = """
  if (platform === "youtube") {
    const result = await downloadYouTubeApiChain(url, audioOnly);
    
    // Attempt R2 Upload just like yt-dlp does
    if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_BUCKET_NAME) {
      try {
        const s3Client = new S3Client({
          region: "auto",
          endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: process.env.R2_ACCESS_KEY, secretAccessKey: process.env.R2_SECRET_KEY },
        });

        const fileStream = createReadStream(result.filePath);
        const uploadParams = {
          Bucket: process.env.R2_BUCKET_NAME,
          Key: `downloads/${Date.now()}_${basename(result.filePath)}`,
          Body: fileStream,
          ContentType: result.contentType,
        };

        const uploader = new Upload({ client: s3Client, params: uploadParams });
        await uploader.done();
        await fsPromises.unlink(result.filePath).catch(() => {});

        const publicUrl = process.env.R2_PUBLIC_URL 
          ? `${process.env.R2_PUBLIC_URL}/${uploadParams.Key}` 
          : `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${uploadParams.Key}`;

        return { filePath: null, url: publicUrl, contentType: result.contentType, title: result.title };
      } catch (uploadErr) {
        console.error("[Downloader] R2 Upload failed:", uploadErr);
      }
    }
    return { filePath: result.filePath, url: null, contentType: result.contentType, title: result.title };
  }
"""

code = re.sub(
    r"export async function downloadWithYtDlp\(url, audioOnly = false, quality = \"720\"\) \{\s*const platform = detectPlatform\(url\);\s*if \(\!platform\) throw new Error\(\"Unsupported platform\.\"\);",
    "export async function downloadWithYtDlp(url, audioOnly = false, quality = \"720\") {\\n  const platform = detectPlatform(url);\\n  if (!platform) throw new Error(\"Unsupported platform.\");\\n" + ytApiLogic,
    code
)

getMediaInfoYtLogic = """
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
"""

code = re.sub(
    r"export async function getMediaInfo\(url\) \{\s*const platform = detectPlatform\(url\);\s*if \(\!platform\) throw new Error\(\"Unsupported platform\.\"\);",
    "export async function getMediaInfo(url) {\\n  const platform = detectPlatform(url);\\n  if (!platform) throw new Error(\"Unsupported platform.\");\\n" + getMediaInfoYtLogic,
    code
)

with open("src/downloader.js", "w", encoding="utf-8") as f:
    f.write(code)

