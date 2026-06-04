import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { getYtDlpPath, getCookiesPath } from "../downloader.js";
import { heavyQueue } from "../queue.js";
import NodeID3 from "node-id3";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ─── Direct yt-dlp audio downloader (bypasses the generic downloader) ─────────
async function downloadAudioDirect(query) {
  const cookiePath = await getCookiesPath();
  const tmpFile = join(tmpdir(), `spotify_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

  const args = [
    `ytsearch1:${query}`,
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "--extractor-args", "youtube:player_client=android_vr,web_embedded;skip=dash,hls",
    "-o", tmpFile,
    "--print", "%(title)s",
  ];

  if (cookiePath) args.push("--cookies", cookiePath);

  return heavyQueue.execute(() => new Promise((resolve, reject) => {
    const proc = spawn(getYtDlpPath(), args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Audio download timed out (3 min)"));
    }, 180000);

    proc.on("close", async (code) => {
      clearTimeout(timeout);
      if (cookiePath) await fs.unlink(cookiePath).catch(() => {});

      if (code !== 0) {
        const errLine = stderr.split("\n").find(l => l.includes("ERROR:")) || stderr.slice(0, 300) || "Unknown error";
        return reject(new Error(`yt-dlp failed: ${errLine}`));
      }

      try {
        const buffer = await fs.readFile(tmpFile);
        await fs.unlink(tmpFile).catch(() => {});
        const title = stdout.trim().split("\n")[0] || "Audio";
        resolve({ buffer, title });
      } catch (err) {
        reject(new Error("yt-dlp produced no output file."));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  }));
}

export const spotifyCommands = {
  spotify: {
    adminOnly: false,
    requiresArgs: true,
    description: "Download a song with album art & metadata",
    usage: "!spotify <song name and artist>",
    example: "!spotify shape of you ed sheeran",
    handler: async (sock, msg, args, from) => {
      const query = args.join(" ");

      try {
        // 1. Fetch metadata and high-res cover art from iTunes API (free, no keys needed)
        const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=1&entity=song`);
        const itunesData = await itunesRes.json();
        
        let title = query;
        let artist = "";
        let album = "";
        let coverBuffer = null;

        if (itunesData.results && itunesData.results.length > 0) {
          const track = itunesData.results[0];
          title = track.trackName;
          artist = track.artistName;
          album = track.collectionName || "";
          
          const coverUrl = track.artworkUrl100
            ? track.artworkUrl100.replace("100x100bb", "1000x1000bb")
            : null;
          
          if (coverUrl) {
            try {
              const imgRes = await fetch(coverUrl);
              coverBuffer = Buffer.from(await imgRes.arrayBuffer());
            } catch { /* cover art is optional */ }
          }
        }

        // 2. Download audio from YouTube via direct yt-dlp call
        const searchQuery = `${title} ${artist}`.trim();
        const { buffer } = await downloadAudioDirect(searchQuery);

        // 3. Embed ID3 tags (cover art, title, artist, album)
        const tags = { title, artist, album };
        
        if (coverBuffer) {
          tags.image = {
            mime: "image/jpeg",
            type: { id: 3, name: "front cover" },
            description: "Cover",
            imageBuffer: coverBuffer,
          };
        }

        const taggedBuffer = NodeID3.write(tags, buffer);

        // 4. Send the tagged MP3 to WhatsApp
        await sock.sendMessage(from, {
          audio: taggedBuffer,
          mimetype: "audio/mpeg",
          ptt: false,
          fileName: `${title} - ${artist}.mp3`,
          contextInfo: {
            externalAdReply: {
              title: title,
              body: artist,
              mediaType: 2,
              thumbnail: coverBuffer,
              sourceUrl: "https://open.spotify.com",
            },
          },
        }, { quoted: msg });

        await reactMsg(sock, from, msg, "✅");

      } catch (err) {
        console.error("Spotify downloader error:", err);
        await failMsg(sock, from, msg, "Failed to download the song. Please try another search term.");
      }
    },
  },
};
