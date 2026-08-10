import { execFile }                     from "child_process";
import { promisify }                    from "util";
import { promises as fsPromises }       from "fs";

const execFilePromise = promisify(execFile);
import { tmpdir }                       from "os";
import { join }                         from "path";
import { replyMsg, reactMsg, alertOwner } from "./helpers.js";
import { cachedGetSetting }             from "../cache.js";

// ─── Google TTS ───────────────────────────────────────────────────────────────

/**
 * Fetches speech audio from the Google Translate TTS endpoint.
 * Returns a raw MP3 Buffer — NOT yet suitable for WhatsApp Android PTT.
 * The buffer is passed to convertToWhatsAppAudio() before sending.
 *
 * @param {string} text  - Text to synthesise (max 200 chars per request)
 * @param {string} lang  - BCP-47 language code, e.g. "en", "fr", "es"
 * @returns {Promise<Buffer>} Raw MP3 buffer from Google
 */
async function textToSpeech(text, lang = "en") {
  const encoded = encodeURIComponent(text.slice(0, 200));
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Referer":    "https://translate.google.com/",
    },
  });

  if (!res.ok) throw new Error(`Google TTS error: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── OGG/Opus Conversion ──────────────────────────────────────────────────────

/**
 * Converts any audio buffer (MP3, M4A, WAV …) to OGG/Opus using ffmpeg.
 *
 * WHY OGG/OPUS IS REQUIRED:
 *   WhatsApp Android validates the audio container and codec before playing
 *   a voice note (PTT). It strictly requires:
 *     • Container : OGG
 *     • Codec     : Opus  (libopus)
 *     • Channels  : mono  (1 channel)  — stereo PTT notes are rejected
 *     • Sample rate: 48 000 Hz         — WA's internal resampler expects this
 *     • MIME type : "audio/ogg; codecs=opus"
 *
 *   iOS WhatsApp is permissive and plays MP3/M4A even with `ptt:true`, which
 *   is why the bug only surfaces on Android. Sending the correctly-encoded
 *   OGG/Opus file works on both platforms.
 *
 * FFMPEG FLAGS:
 *   -c:a libopus     Encode with the Opus codec
 *   -b:a 64k         64 kbps — good quality for voice, small file size
 *   -vbr on          Variable bit-rate within the target (better quality/size)
 *   -compression_level 10  Highest Opus compression (CPU cheap; no quality loss)
 *   -ar 48000        Resample to 48 kHz (WhatsApp standard)
 *   -ac 1            Downmix to mono (required for PTT)
 *
 * TEMP FILES:
 *   We write the input to a tmp file and read the output from another.
 *   spawnSync is synchronous and avoids stream/pipe complexity.
 *   Both temp files are always cleaned up in the finally block.
 *
 * @param {Buffer} inputBuffer   - Raw audio in any format ffmpeg can decode
 * @param {string} [inputExt]    - File extension hint for ffmpeg demuxer, e.g. "mp3"
 * @returns {Buffer} OGG/Opus buffer ready for WhatsApp PTT
 */
async function convertToWhatsAppAudio(inputBuffer, inputExt = "mp3") {
  const ts      = Date.now();
  const inPath  = join(tmpdir(), `tts_in_${ts}.${inputExt}`);
  const outPath = join(tmpdir(), `tts_out_${ts}.ogg`);

  await fsPromises.writeFile(inPath, inputBuffer);

  try {
    await execFilePromise("ffmpeg", [
      "-y",                          // overwrite output without prompting
      "-i",         inPath,          // input file
      "-c:a",       "libopus",       // Opus codec — mandatory for WA Android PTT
      "-b:a",       "64k",           // 64 kbps target bitrate
      "-vbr",       "on",            // variable bit-rate (better quality/size ratio)
      "-compression_level", "10",    // max Opus compression (lossless quality-wise)
      "-ar",        "48000",         // 48 kHz sample rate — WhatsApp standard
      "-ac",        "1",             // mono — required; stereo PTT fails on Android
      outPath,
    ], { timeout: 30_000 });

    return await fsPromises.readFile(outPath);

  } catch (err) {
    const stderr = err.stderr?.toString()?.slice(0, 300) ?? "ffmpeg failed";
    throw new Error(`ffmpeg conversion failed: ${stderr}`);
  } finally {
    await fsPromises.unlink(inPath).catch(()=>{});
    await fsPromises.unlink(outPath).catch(()=>{});
  }
}

// ─── AI + TTS combined ────────────────────────────────────────────────────────

/**
 * Calls the Gemini Flash API and returns a short, speech-friendly plain-text reply.
 *
 * @param {string} prompt      - User's question or message
 * @param {string} geminiKey   - Gemini API key from bot settings
 * @returns {Promise<string>}
 */
async function getAiResponse(prompt, geminiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role:  "user",
            parts: [{ text: `[System]: You are a helpful assistant. Keep responses short and conversational — under 3 sentences. No markdown, no bullet points, just plain speech.\n\n${prompt}` }],
          },
        ],
        generationConfig: { maxOutputTokens: 200 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Gemini API error: ${res.status}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "I could not generate a response.";
}

// ─── Shared PTT sender ────────────────────────────────────────────────────────

/**
 * Converts text to speech and sends it as a WhatsApp voice note.
 *
 * The pipeline is:
 *   Google TTS (MP3)  →  ffmpeg (OGG/Opus, 48kHz, mono)  →  sock.sendMessage
 *
 * The MIME type "audio/ogg; codecs=opus" is the ONLY value WhatsApp Android
 * accepts for ptt:true messages. iOS accepts both this and audio/mpeg, so
 * using OGG/Opus makes the note compatible on all platforms.
 *
 * @param {object} sock         - Baileys socket
 * @param {string} from         - Chat JID
 * @param {object} msg          - Original message (for quoting)
 * @param {string} text         - Text to synthesise
 * @param {string} [lang="en"]  - Language code
 */
async function sendVoiceNote(sock, from, msg, text, lang = "en") {
  // Step 1: Fetch MP3 from Google TTS
  const mp3Buffer = await textToSpeech(text, lang);

  // Step 2: Re-encode to OGG/Opus (Android-compatible PTT format)
  const oggBuffer = await convertToWhatsAppAudio(mp3Buffer, "mp3");

  // Step 3: Send as voice note
  //
  //   ptt: true                       — renders as a voice note (play bar UI)
  //   mimetype: "audio/ogg; codecs=opus" — the only MIME WhatsApp Android
  //                                     validates for PTT; "audio/mpeg" fails
  //
  //   Do NOT include `fileName` for PTT messages — some WhatsApp versions
  //   treat a fileName as an audio attachment (file bubble) not a voice note.

  await sock.sendMessage(from, {
    audio:    oggBuffer,
    mimetype: "audio/ogg; codecs=opus",
    ptt:      true,
  }, { quoted: msg });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const voiceCommands = {

  voice: {
    adminOnly:    false,
    requiresArgs: true,
    description:  "Ask AI a question and get a voice note reply",
    usage:        "!voice <message>",
    examples:     ["!voice What is the capital of Ghana?", "!voice Tell me a joke"],
    handler: async (sock, msg, args, from, prefix) => {
      const prompt = args.join(" ").trim();
      if (!prompt) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}voice*\n\n🔧 *Syntax:*\n${prefix}voice <message>\n\n💡 *Example:*\n• ${prefix}voice Tell me a joke`
      );

      await reactMsg(sock, from, msg, "🎙️");

      try {
        const geminiKey = cachedGetSetting("gemini_api_key", null);
        if (!geminiKey) return replyMsg(sock, from, msg,
          `❌ Gemini API key not set. Admin can set it with: *!setgeminikey <key>*`
        );

        // Get AI response text
        const aiText = await getAiResponse(prompt, geminiKey);

        // Convert to OGG/Opus and send as voice note
        await sendVoiceNote(sock, from, msg, aiText);

        await reactMsg(sock, from, msg, "✅");

        // Also send the text so the user can read it
        await replyMsg(sock, from, msg, `💬 _${aiText}_`);

      } catch (err) {
        console.error("❌ Voice error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ Voice reply failed: ${err.message}`);
        await alertOwner(sock, `${prefix}voice`, err);
      }
    },
  },

  tts: {
    adminOnly:    false,
    requiresArgs: true,
    description:  "Convert any text to a voice note",
    usage:        "!tts <text>",
    examples:     ["!tts Hello everyone!", "!tts Good morning"],
    handler: async (sock, msg, args, from, prefix) => {
      const text = args.join(" ").trim();
      if (!text) return replyMsg(sock, from, msg,
        `📖 *How to use ${prefix}tts*\n\n🔧 *Syntax:*\n${prefix}tts <text>`
      );

      await reactMsg(sock, from, msg, "🎙️");

      try {
        // Convert to OGG/Opus and send as voice note
        await sendVoiceNote(sock, from, msg, text);

        await reactMsg(sock, from, msg, "✅");

      } catch (err) {
        console.error("❌ TTS error:", err.message);
        await reactMsg(sock, from, msg, "❌");
        await replyMsg(sock, from, msg, `❌ TTS failed: ${err.message}`);
        await alertOwner(sock, `${prefix}tts`, err);
      }
    },
  },

};
