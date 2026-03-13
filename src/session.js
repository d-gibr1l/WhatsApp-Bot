import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir, readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { SUPABASE_URL, SUPABASE_KEY, botConfig, SESSION_DIR } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function loadSessionFromSupabase() {
  try {
    // Try with known number first, fall back to any saved session
    if (botConfig.BOT_NUMBER) {
      const { data } = await supabase
        .from("sessions").select("auth")
        .eq("number", botConfig.BOT_NUMBER).single();
      if (data?.auth) return data.auth;
    }

    // No number yet (first scan) — load the most recent session
    const { data } = await supabase
      .from("sessions").select("auth, number")
      .limit(1).single();

    if (data?.auth) {
      if (data.number && !botConfig.BOT_NUMBER) {
        botConfig.BOT_NUMBER = data.number;
        console.log(`📱 Bot number restored from session: ${data.number}`);
      }
      return data.auth;
    }
    return null;
  } catch (err) {
    console.error("❌ Failed to load session:", err.message);
    return null;
  }
}

// Read all session files from disk and save them to Supabase
export async function saveSessionToSupabase() {
  try {
    if (!existsSync(SESSION_DIR)) return;
    if (!botConfig.BOT_NUMBER) return;

    const files = await readdir(SESSION_DIR);
    const keys = {};

    let creds = null;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = JSON.parse(await readFile(path.join(SESSION_DIR, file), "utf8"));
      if (file === "creds.json") {
        creds = content;
      } else {
        // Key files are named like "app-state-sync-key-XXXXX.json", "pre-key-X.json" etc
        const keyName = file.replace(".json", "");
        keys[keyName] = content;
      }
    }

    if (!creds) return;

    const { error } = await supabase
      .from("sessions")
      .upsert(
        { number: botConfig.BOT_NUMBER, auth: { creds, keys } },
        { onConflict: "number" }
      );
    if (error) console.error("❌ Failed to save session:", error.message);
  } catch (err) {
    console.error("❌ Unexpected error saving session:", err.message);
  }
}

export async function clearSessionFromSupabase() {
  try {
    await supabase.from("sessions").delete().eq("number", botConfig.BOT_NUMBER);
    console.log("🗑️  Supabase session cleared");
  } catch (err) {
    console.error("❌ Failed to clear session:", err.message);
  }
}

export async function hydrateSessionFromSupabase() {
  const saved = await loadSessionFromSupabase();
  if (!saved) return false;

  try {
    if (!existsSync(SESSION_DIR)) {
      await mkdir(SESSION_DIR, { recursive: true });
    }

    const { creds, keys } = saved;

    if (creds) {
      await writeFile(
        path.join(SESSION_DIR, "creds.json"),
        JSON.stringify(creds, null, 2)
      );
    }

    if (keys && Object.keys(keys).length > 0) {
      for (const [name, keyData] of Object.entries(keys)) {
        await writeFile(
          path.join(SESSION_DIR, `${name}.json`),
          JSON.stringify(keyData, null, 2)
        );
      }
      console.log(`✅ Session hydrated from Supabase (${Object.keys(keys).length} key files)`);
    } else {
      console.log("✅ Session hydrated from Supabase (creds only — keys will sync on connect)");
    }

    return true;
  } catch (err) {
    console.error("❌ Failed to hydrate session files:", err.message);
    return false;
  }
}
