import { createClient } from "@supabase/supabase-js";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { writeFile, mkdir, readdir, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import path from "path";
import { SUPABASE_URL, SUPABASE_KEY, botConfig, SESSION_DIR } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Load session files from Supabase → disk ──────────────────────────────────
export async function loadSession() {
  try {
    let data = null;

    if (botConfig.BOT_NUMBER) {
      const res = await supabase.from("sessions").select("session, number")
        .eq("number", botConfig.BOT_NUMBER).single();
      data = res.data;
    }

    if (!data) {
      const res = await supabase.from("sessions").select("session, number").limit(1).single();
      data = res.data;
    }

    if (!data?.session) {
      console.log("🆕 No saved session — fresh start");
      return false;
    }

    // Decompress and write all files to SESSION_DIR
    const files = JSON.parse(gunzipSync(Buffer.from(data.session, "base64")).toString());

    if (!existsSync(SESSION_DIR)) await mkdir(SESSION_DIR, { recursive: true });

    for (const [filename, content] of Object.entries(files)) {
      await writeFile(path.join(SESSION_DIR, filename), JSON.stringify(content), "utf8");
    }

    if (data.number && !botConfig.BOT_NUMBER) {
      botConfig.BOT_NUMBER = data.number;
      console.log(`📱 Bot number restored from session: ${data.number}`);
    }

    const keyCount = Object.keys(files).filter(f => f !== "creds.json").length;
    console.log(`✅ Session hydrated — creds + ${keyCount} key files`);
    return true;
  } catch (err) {
    console.log("🆕 No saved session — fresh start");
    return false;
  }
}

// ─── Save all session files from disk → Supabase ─────────────────────────────
export async function saveSession() {
  try {
    if (!botConfig.BOT_NUMBER) return;
    if (!existsSync(SESSION_DIR)) return;

    const files = await readdir(SESSION_DIR);
    const fileMap = {};

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = JSON.parse(await readFile(path.join(SESSION_DIR, file), "utf8"));
      fileMap[file] = content;
    }

    if (!fileMap["creds.json"]) return;

    const compressed = gzipSync(JSON.stringify(fileMap)).toString("base64");

    const { error } = await supabase.from("sessions").upsert(
      { number: botConfig.BOT_NUMBER, session: compressed },
      { onConflict: "number" }
    );
    if (error) console.error("❌ Failed to save session:", error.message);
  } catch (err) {
    console.error("❌ Unexpected error saving session:", err.message);
  }
}

// ─── Clear session ────────────────────────────────────────────────────────────
export async function clearSession() {
  try {
    // Wipe disk files
    if (existsSync(SESSION_DIR)) {
      await rm(SESSION_DIR, { recursive: true, force: true });
    }
    // Wipe Supabase
    if (botConfig.BOT_NUMBER) {
      await supabase.from("sessions").delete().eq("number", botConfig.BOT_NUMBER);
    }
    console.log("🗑️  Session cleared");
  } catch (err) {
    console.error("❌ Failed to clear session:", err.message);
  }
}

// ─── Get Baileys auth state (uses real useMultiFileAuthState) ─────────────────
export async function getAuthState() {
  if (!existsSync(SESSION_DIR)) await mkdir(SESSION_DIR, { recursive: true });
  return useMultiFileAuthState(SESSION_DIR);
}
