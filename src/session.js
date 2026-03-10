import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { SUPABASE_URL, SUPABASE_KEY, BOT_NUMBER, SESSION_DIR } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function loadSessionFromSupabase() {
  try {
    const { data, error } = await supabase
      .from("sessions")
      .select("auth")
      .eq("number", BOT_NUMBER)
      .single();

    if (error || !data?.auth) return null;
    return data.auth;
  } catch (err) {
    console.error("❌ Failed to load session:", err.message);
    return null;
  }
}

export async function saveSessionToSupabase(creds, keys) {
  try {
    const { error } = await supabase
      .from("sessions")
      .upsert(
        { number: BOT_NUMBER, auth: { creds, keys } },
        { onConflict: "number" }
      );
    if (error) console.error("❌ Failed to save session:", error.message);
  } catch (err) {
    console.error("❌ Unexpected error saving session:", err.message);
  }
}

export async function clearSessionFromSupabase() {
  try {
    await supabase.from("sessions").delete().eq("number", BOT_NUMBER);
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

    if (keys) {
      for (const [type, keyData] of Object.entries(keys)) {
        await writeFile(
          path.join(SESSION_DIR, `${type}.json`),
          JSON.stringify(keyData, null, 2)
        );
      }
    }

    console.log("✅ Session hydrated from Supabase");
    return true;
  } catch (err) {
    console.error("❌ Failed to hydrate session files:", err.message);
    return false;
  }
}
