import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { downloadWithYtDlp } from "../downloader.js";
import NodeID3 from "node-id3";

export const spotifyCommands = {
  spotify: {
    adminOnly: false,
    requiresArgs: true,
    description: "Download a song perfectly tagged with high-res Album Art (from iTunes)",
    usage: "!spotify <song name and artist>",
    example: "!spotify shape of you ed sheeran",
    handler: async (sock, msg, args, from) => {
      const query = args.join(" ");

      await reactMsg(sock, from, msg, "🎵");

      try {
        // 1. Fetch exact metadata and high-res cover art from iTunes API (free, no rate limits)
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
          
          const coverUrl = track.artworkUrl100 ? track.artworkUrl100.replace("100x100bb", "1000x1000bb") : null;
          
          if (coverUrl) {
            try {
              const imgRes = await fetch(coverUrl);
              coverBuffer = Buffer.from(await imgRes.arrayBuffer());
            } catch (err) {
              console.warn("Failed to download cover art:", err);
            }
          }
        }

        // 2. Download the highest quality audio from YouTube matching the track using ytsearch
        const searchString = `ytsearch1:${title} ${artist} audio`;
        const { buffer } = await downloadWithYtDlp(searchString, true); // audioOnly = true

        // 3. Write ID3 Tags (Cover Art, Title, Artist, Album)
        const tags = {
          title: title,
          artist: artist,
          album: album,
        };
        
        if (coverBuffer) {
          tags.image = {
            mime: "image/jpeg",
            type: {
              id: 3,
              name: "front cover"
            },
            description: "Cover",
            imageBuffer: coverBuffer
          };
        }

        const taggedBuffer = NodeID3.write(tags, buffer);

        // 4. Send the perfectly tagged MP3 back to WhatsApp
        await sock.sendMessage(from, {
          audio: taggedBuffer,
          mimetype: "audio/mpeg",
          ptt: false, // Send as a document-style music file, not a voice note
          fileName: `${title} - ${artist}.mp3`,
          contextInfo: {
            externalAdReply: {
              title: title,
              body: artist,
              mediaType: 2,
              thumbnail: coverBuffer,
              sourceUrl: "https://open.spotify.com"
            }
          }
        }, { quoted: msg });

      } catch (err) {
        console.error("Spotify downloader error:", err);
        await failMsg(sock, from, msg, "Failed to download the song. Please try another search term.");
      }
    }
  }
};
