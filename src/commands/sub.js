import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises, existsSync } from "fs";

const execPromise = promisify(exec);
import { tmpdir } from "os";
import { join } from "path";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";
import { getYtDlpPath, getCookiesPath, getMediaInfo } from "../downloader.js";

export const subCommands = {
  sub: {
    adminOnly: false,
    requiresArgs: true,
    description: "Extract subtitles/captions from a YouTube video",
    usage: "!sub <url> [language]",
    examples: [
      "!sub https://youtu.be/xxxx",
      "!sub https://youtu.be/xxxx en",
      "!sub https://youtu.be/xxxx es",
    ],
    notes: "Defaults to English (en). Uses auto-generated captions if manual subs unavailable.",
    handler: async (sock, msg, args, from, prefix) => {
      const url  = args[0];
      const lang = args[1] || "en";

      if (!url?.startsWith("http")) return replyMsg(sock, from, msg,
        `📖 *${prefix}sub <url> [language]*\n\nExtract captions from a YouTube video.\n\n💡 Examples:\n• ${prefix}sub https://youtu.be/xxxx\n• ${prefix}sub https://youtu.be/xxxx es`
      );

      await reactMsg(sock, from, msg, "📝");

      const tmpDir  = join(tmpdir(), `sub_${Date.now()}`);
      const tmpBase = join(tmpDir, "sub");
      const cookiePath = await getCookiesPath();
      const cookiesFlag = cookiePath ? `--cookies "${cookiePath}"` : "";
      const ytDlpPath = getYtDlpPath();

      try {
        // Create temp dir
        await fsPromises.mkdir(tmpDir, { recursive: true });

        // Try manual subs first, fall back to auto-generated
        let subFile = null;
        try {
          await execPromise(
            `"${ytDlpPath}" --write-subs --sub-lang ${lang} --skip-download --convert-subs srt ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" -o "${tmpBase}" "${url}"`,
            { timeout: 30000 }
          );
          subFile = `${tmpBase}.${lang}.srt`;
          if (!existsSync(subFile)) subFile = null;
        } catch {}

        if (!subFile) {
          await execPromise(
            `"${ytDlpPath}" --write-auto-subs --sub-lang ${lang} --skip-download --convert-subs srt ${cookiesFlag} --extractor-args "youtube:player_client=android_vr,web_embedded;skip=dash,hls" -o "${tmpBase}" "${url}"`,
            { timeout: 30000 }
          );
          subFile = `${tmpBase}.${lang}.srt`;
        }

        if (!existsSync(subFile)) {
          throw new Error(`No subtitles found for language "${lang}". Try a different language code.`);
        }

        // Parse SRT — strip timestamps, deduplicate lines
        const raw = await fsPromises.readFile(subFile, "utf8");
        const lines = raw.split("\n");
        const textLines = [];
        let prev = "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || /^\d+$/.test(trimmed) || trimmed.includes("-->")) continue;
          // Remove HTML tags like <i>, <b>, <font>
          const clean = trimmed.replace(/<[^>]+>/g, "").trim();
          if (clean && clean !== prev) {
            textLines.push(clean);
            prev = clean;
          }
        }

        if (textLines.length === 0) throw new Error("Subtitles found but appear to be empty.");

        // Get title for header
        let title = url;
        try { title = (await getMediaInfo(url)).title; } catch {}

        const subtitleText = textLines.join("\n");
        const header = `📝 *Subtitles: ${title}*\n🌐 Language: ${lang}\n\n`;

        // WhatsApp message limit ~65K chars — split if needed
        const MAX = 4000;
        if (subtitleText.length <= MAX) {
          await reactMsg(sock, from, msg, "✅");
          await replyMsg(sock, from, msg, header + subtitleText);
        } else {
          await reactMsg(sock, from, msg, "✅");
          await replyMsg(sock, from, msg, header + subtitleText.slice(0, MAX) + "\n\n_...truncated (too long)_");
        }

      } catch (err) {
        console.error("❌ sub error:", err.message);
        if (err.message.includes("No subtitles")) {
          await reactMsg(sock, from, msg, "❌");
          await replyMsg(sock, from, msg, `❌ ${err.message}`);
        } else {
          await failMsg(sock, from, msg, err, "sub");
        }
      } finally {
        await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(()=>{});
        if (cookiePath && existsSync(cookiePath)) {
          await fsPromises.unlink(cookiePath).catch(()=>{});
        }
      }
    },
  },
};
