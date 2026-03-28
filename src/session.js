import { createClient } from "@supabase/supabase-js";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "supabase-baileys";
import { mkdir, existsSync, readFile, writeFile, rm } from "fs/promises";
import path from "path";
import { Boom } from "@hapi/boom";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { SUPABASE_URL, SUPABASE_KEY, botConfig } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const CACHE_DIR = `./sessions/${botConfig.BOT_NUMBER || 'default'}`;
let syncInterval = null;
let remoteState = null;
let isSyncing = false;

// ─── Sync disk cache to Supabase (async, batched) ────────────────────────────
async function syncToSupabase(sessionId) {
  if (isSyncing) return;
  isSyncing = true;
  
  try {
    const { state } = await useMultiFileAuthState(CACHE_DIR);
    remoteState = await useSupabaseAuthState({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_KEY,
      session: sessionId,
      tableName: "auth",
    });
    
    // Sync creds
    if (state.creds) {
      await remoteState.saveCreds();
    }
    
    // Sync keys (batched upsert)
    const keys = Object.keys(state.keys);
    for (const key of keys) {
      try {
        await remoteState.keys.set(key, state.keys[key]);
      } catch {}
    }
    
    console.log(`🔄 Synced ${keys.length} keys to Supabase`);
  } catch (err) {
    console.error("❌ Supabase sync failed:", err.message);
  } finally {
    isSyncing = false;
  }
}

// ─── Get buffered auth state: disk-first, Supabase fallback/async backup ─────
export async function getAuthState() {
  const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default";
  
  // Ensure cache dir
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
    console.log(`📁 Created cache: ${CACHE_DIR}`);
  }
  
  // Check if cache exists
  const cacheCredsPath = path.join(CACHE_DIR, 'creds.json');
  if (existsSync(cacheCredsPath)) {
    console.log("💾 Using disk cache (fast)");
    
    const { state, saveCreds } = await useMultiFileAuthState(CACHE_DIR);
    
    // Setup background sync
    if (!syncInterval) {
      syncInterval = setInterval(() => syncToSupabase(sessionId), 30000); // 30s
      console.log("⏰ Background sync started");
    }
    
    // Return buffered saveCreds (local + async remote)
    const bufferedSaveCreds = async () => {
      await saveCreds();  // Local disk (instant)
      syncToSupabase(sessionId);  // Async Supabase
    };
    
    return { state, saveCreds: bufferedSaveCreds };
  }
  
  // No cache: Load from Supabase, populate disk
  console.log("☁️  Loading from Supabase → cache");
  const supabaseAuth = await useSupabaseAuthState({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,  // Use SERVICE_ROLE_KEY for speed if possible
    session: sessionId,
    tableName: "auth",
  });
  
  // Copy Supabase state to disk cache (one-time)
  const { state, saveCreds } = await useMultiFileAuthState(CACHE_DIR);
  
  // Trigger initial sync (will populate cache)
  await syncToSupabase(sessionId);
  
  const bufferedSaveCreds = async () => {
    await saveCreds();
    syncToSupabase(sessionId);
  };
  
  // Background sync
  if (!syncInterval) {
    syncInterval = setInterval(() => syncToSupabase(sessionId), 30000);
  }
  
  return { state, saveCreds: bufferedSaveCreds };
}

// ─── Detect bot number from connected socket ──────────────────────────────────
export function setBotNumber(number) {
  botConfig.BOT_NUMBER = number;
}

// ─── Clear session (both cache & Supabase) ───────────────────────────────────
export async function clearSession() {
  try {
    // Clear disk cache
    if (existsSync(CACHE_DIR)) {
      await rm(CACHE_DIR, { recursive: true, force: true });
    }
    
    // Clear Supabase
    const sessionId = botConfig.BOT_NUMBER || "default";
    const { error } = await supabase
      .from("auth")
      .delete()
      .eq("session", sessionId);
    if (error) throw error;
    
    // Stop sync
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
    
    console.log("🗑️  Session cleared (cache + Supabase)");
  } catch (err) {
    console.error("❌ Failed to clear session:", err.message);
  }
}

// ─── Clear ALL sessions ──────────────────────────────────────────────────────
export async function clearAllSessions() {
  try {
    // Clear Supabase
    await supabase.from("auth").delete();
    
    // Clear all caches (if multi-bot)
    const cacheRoot = './sessions';
    if (existsSync(cacheRoot)) {
      await rm(cacheRoot, { recursive: true, force: true });
    }
    
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
    
    console.log("🗑️  All sessions cleared");
  } catch (err) {
    console.error("❌ Failed to clear all sessions:", err.message);
  }
}

// ─── Legacy compatibility ────────────────────────────────────────────────────
export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    console.log("🆕 FORCE_FRESH_SESSION — clearing all");
    await clearAllSessions();
  }
  return true;  // getAuthState handles loading
}

export async function saveSession() {
  // Manual full sync (for graceful shutdown)
  const sessionId = botConfig.BOT_NUMBER || "default";
  await syncToSupabase(sessionId);
  console.log("💾 Full session saved");
}