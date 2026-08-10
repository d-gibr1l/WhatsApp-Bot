import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, promises as fsPromises } from "fs";

const execPromise = promisify(exec);
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg } from "./helpers.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

const MAX_MB = 64;
function sizeMB(buf) { return buf.length / (1024 * 1024); }

async function downloadBuffer(msg) {
  return downloadMediaMessage(msg, "buffer", {});
}

function getQuotedOrDirect(msg, types) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  for (const t of types) {
    if (msg.message?.[t]) return { msgObj: msg, type: t };
    if (quoted?.[t])      return { msgObj: { key: msg.key, message: quoted }, type: t };
  }
  return null;
}

export const mediaToolsCommands = {

  // ── !avm — merge audio + video ────────────────────────────────────────────
  avm: {
    adminOnly: false,
    requiresArgs: false,
    description: "Merge an audio file into a video (replace or add audio)",
    usage: "!avm  (send video, reply to audio — or vice versa)",
    examples: [
      "Send a video, reply to an audio → !avm",
      "Send an audio, reply to a video → !avm",
    ],
    notes: "The audio replaces the video's original audio track.",
    handler: async (sock, msg, _args, from, prefix) => {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

      const directVid = msg.message?.videoMessage;
      const directAud = msg.message?.audioMessage;
      const quotedVid = quoted?.videoMessage;
      const quotedAud = quoted?.audioMessage;

      const hasVideo = !!(directVid || quotedVid);
      const hasAudio = !!(directAud || quotedAud);

      if (!hasVideo || !hasAudio) {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}avm*\n\nMerge audio into a video.\n\n` +
          `*How to use:*\n• Send a video, reply to an audio with *${prefix}avm*\n• Send an audio, reply to a video with *${prefix}avm*`
        );
      }

      await reactMsg(sock, from, msg, "⏳");

      const vidMsg = directVid ? msg : { key: msg.key, message: quoted };
      const audMsg = directAud ? msg : { key: msg.key, message: quoted };

      const tmpVid = join(tmpdir(), `avm_v_${Date.now()}.mp4`);
      const tmpAud = join(tmpdir(), `avm_a_${Date.now()}.mp3`);
      const tmpOut = join(tmpdir(), `avm_out_${Date.now()}.mp4`);

      try {
        await fsPromises.writeFile(tmpVid, await downloadBuffer(vidMsg));
        await fsPromises.writeFile(tmpAud, await downloadBuffer(audMsg));

        await execPromise(
          `ffmpeg -i "${tmpVid}" -i "${tmpAud}" -map 0:v -map 1:a -c:v copy -shortest "${tmpOut}" -y`,
          { timeout: 120000 }
        );

        if (!existsSync(tmpOut)) throw new Error("ffmpeg produced no output.");
        const buf = await fsPromises.readFile(tmpOut);

        if (sizeMB(buf) > MAX_MB) return replyMsg(sock, from, msg, `❌ Output too large (${sizeMB(buf).toFixed(1)}MB).`);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { video: buf, mimetype: "video/mp4" }, { quoted: msg });
      } finally {
        for (const f of [tmpVid, tmpAud, tmpOut]) await fsPromises.unlink(f).catch(()=>{});
      }
    },
  },

  // ── !avec — audio to video with black background ─────────────────────────
  avec: {
    adminOnly: false,
    requiresArgs: false,
    description: "Convert an audio clip into a video with a black background",
    usage: "!avec",
    examples: ["Reply to an audio → !avec", "Send an audio with caption !avec"],
    handler: async (sock, msg, _args, from, prefix) => {
      const media = getQuotedOrDirect(msg, ["audioMessage"]);
      if (!media) {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}avec*\n\nConvert audio to a black-background video.\n\nReply to an audio message with *${prefix}avec*`
        );
      }

      await reactMsg(sock, from, msg, "⏳");

      const tmpAud = join(tmpdir(), `avec_a_${Date.now()}.mp3`);
      const tmpOut = join(tmpdir(), `avec_out_${Date.now()}.mp4`);

      try {
        await fsPromises.writeFile(tmpAud, await downloadBuffer(media.msgObj));

        await execPromise(
          `ffmpeg -f lavfi -i color=c=black:s=640x360:r=30 -i "${tmpAud}" -map 0:v -map 1:a -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest "${tmpOut}" -y`,
          { timeout: 120000 }
        );

        if (!existsSync(tmpOut)) throw new Error("ffmpeg produced no output.");
        const buf = await fsPromises.readFile(tmpOut);

        if (sizeMB(buf) > MAX_MB) return replyMsg(sock, from, msg, `❌ Output too large (${sizeMB(buf).toFixed(1)}MB).`);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { video: buf, mimetype: "video/mp4" }, { quoted: msg });
      } finally {
        for (const f of [tmpAud, tmpOut]) await fsPromises.unlink(f).catch(()=>{});
      }
    },
  },

  // ── !merge — merge multiple videos ───────────────────────────────────────
  merge: {
    adminOnly: false,
    requiresArgs: false,
    description: "Merge multiple videos into one — send the first, reply to the second",
    usage: "!merge  (send one video, reply to another)",
    examples: ["Send a video, reply to another video → !merge"],
    notes: "Both videos must be sent in the same chat. The direct video plays first.",
    handler: async (sock, msg, _args, from, prefix) => {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const hasDirectVid = !!msg.message?.videoMessage;
      const hasQuotedVid = !!quoted?.videoMessage;

      if (!hasDirectVid || !hasQuotedVid) {
        return replyMsg(sock, from, msg,
          `📖 *${prefix}merge*\n\nMerge two videos into one.\n\n` +
          `*How to use:*\nSend a video, then reply to another video with *${prefix}merge*\n\n` +
          `The video you send plays first.`
        );
      }

      await reactMsg(sock, from, msg, "⏳");

      const tmpDir  = join(tmpdir(), `merge_${Date.now()}`);
      await fsPromises.mkdir(tmpDir, { recursive: true });
      const tmp1    = join(tmpDir, "v1.mp4");
      const tmp2    = join(tmpDir, "v2.mp4");
      const tmpList = join(tmpDir, "list.txt");
      const tmpOut  = join(tmpDir, "out.mp4");

      try {
        await fsPromises.writeFile(tmp1, await downloadBuffer(msg));
        await fsPromises.writeFile(tmp2, await downloadBuffer({ key: msg.key, message: quoted }));

        // Re-encode both to same format before concat
        const tmp1r = join(tmpDir, "v1r.mp4");
        const tmp2r = join(tmpDir, "v2r.mp4");
        await execPromise(`ffmpeg -i "${tmp1}" -c:v libx264 -c:a aac "${tmp1r}" -y`, { timeout: 60000 });
        await execPromise(`ffmpeg -i "${tmp2}" -c:v libx264 -c:a aac "${tmp2r}" -y`, { timeout: 60000 });

        await fsPromises.writeFile(tmpList, `file '${tmp1r}'\nfile '${tmp2r}'\n`);
        await execPromise(`ffmpeg -f concat -safe 0 -i "${tmpList}" -c copy "${tmpOut}" -y`, { timeout: 120000 });

        if (!existsSync(tmpOut)) throw new Error("ffmpeg produced no output.");
        const buf = await fsPromises.readFile(tmpOut);

        if (sizeMB(buf) > MAX_MB) return replyMsg(sock, from, msg, `❌ Merged file too large (${sizeMB(buf).toFixed(1)}MB).`);

        await reactMsg(sock, from, msg, "✅");
        await sock.sendMessage(from, { video: buf, mimetype: "video/mp4" }, { quoted: msg });
      } finally {
        try { await execPromise(`rm -rf "${tmpDir}"`); } catch {}
      }
    },
  },

};
