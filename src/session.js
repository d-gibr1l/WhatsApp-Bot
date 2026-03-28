import { createClient } from "@supabase/supabase-js";
import { useSupabaseAuthState } from "supabase-baileys";
import { SUPABASE_URL, SUPABASE_KEY, botConfig } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Get auth state directly from Supabase via supabase-baileys ──────────────
// No disk files, no compression, no bulk serialization.
// Keys are stored as individual JSONB rows — exactly how Baileys expects them.

export async function getAuthState() {
  const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default";

  const { state, saveCreds } = await useSupabaseAuthState({
    supabaseUrl:  SUPABASE_URL,
    supabaseKey:  SUPABASE_KEY,
    session:      sessionId,
    tableName:    "auth",
  });

  return { state, saveCreds };
}

// ─── Detect bot number from connected socket ──────────────────────────────────
export function setBotNumber(number) {
  botConfig.BOT_NUMBER = number;
}

// ─── Clear session — wipes all rows for this session ID ──────────────────────
export async function clearSession() {
  try {
    const sessionId = botConfig.BOT_NUMBER || "default";
    const { error } = await supabase
      .from("auth")
      .delete()
      .eq("session", sessionId);
    if (error) throw error;
    console.log("🗑️  Session cleared");
  } catch (err) {
    console.error("❌ Failed to clear session:", err.message);
  }
}

// ─── Force fresh session — clears ALL auth rows ───────────────────────────────
export async function clearAllSessions() {
  try {
    await supabase.from("auth").delete().neq("session", "____never____");
    console.log("🗑️  All sessions cleared");
  } catch (err) {
    console.error("❌ Failed to clear all sessions:", err.message);
  }
}

// ─── Legacy stubs — kept so index.js imports don't break ─────────────────────
export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    console.log("🆕 FORCE_FRESH_SESSION — clearing all sessions");
    await clearAllSessions();
  }
  // Nothing to load — supabase-baileys handles hydration in getAuthState()
  return true;
}

export async function saveSession() {
  // Nothing to do — supabase-baileys saves keys on every update automatically
}
