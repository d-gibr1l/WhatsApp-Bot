import { createClient } from "@supabase/supabase-js";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "supabase-baileys";
import { mkdir, readFile, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";  // ✅ Separate import for sync functions
import path from "path";
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
    
    // Sync keys (batched upsert - limit to avoid timeouts)
    const keys = Object.keys(state.keys || {});
    console.log(`🔄 Syncing ${keys.length} keys...`);
    
    for (const key of keys.slice(0, 50)) {  // Batch first 50
      try {
        await remoteState.keys.set(key, state.keys[key]);
      } catch (err) {
        console.warn(`Failed to sync key ${key}:`, err.message);
      }
    }
    
    console.log(`✅ Synced to Supabase`);
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
  
  // Check if cache exists (creds.json is the indicator)
  const cacheCredsPath = path.join(CACHE_DIR, 'creds.json');
  if (existsSync(cacheCredsPath)) {
    console.log("💾 Using disk cache (fast mode)");
    
    const { state, saveCreds } = await useMultiFileAuthState(CACHE_DIR);
    
    // Setup background sync if not running
    if (!syncInterval) {
      syncInterval = setInterval(() => syncToSupabase(sessionId), 30000); // 30s
      console.log("⏰ Background sync enabled");
    }
    
    // Buffered save: local instant + async remote
    const bufferedSaveCreds = async () => {
      try {
        await saveCreds();  // Disk (sync, <10ms)
      } catch (err) {
        console.error("Local save failed:", err);
      }
      // Fire-and-forget Supabase sync
      syncToSupabase(sessionId).catch(console.error);
    };
    
    return { state, saveCreds: bufferedSaveCreds };
  }
  
  // No cache: Bootstrap from Supabase
  console.log("☁️  Bootstrapping cache from Supabase");
  
  const supabaseAuth = await useSupabaseAuthState({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    session: sessionId,
    tableName: "auth",
  });
  
  // Use multi-file for cache, sync will populate it
  const { state, saveCreds } = await useMultiFileAuthState(CACHE_DIR);
  await syncToSupabase(sessionId);  // Initial population
  
  if (!syncInterval) {
    syncInterval = setInterval(() => syncToSupabase(sessionId), 30000);
  }
  
  const bufferedSaveCreds = async () => {
    await saveCreds();
    syncToSupabase(sessionId).catch(console.error);
  };
  
  return { state, saveCreds: bufferedSaveCreds };
}

// ─── Detect bot number ───────────────────────────────────────────────────────
export function setBotNumber(number) {
  if (number !== botConfig.BOT_NUMBER) {
    botConfig.BOT_NUMBER = number;
    // Restart cache dir for new number
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  }
}

// ─── Clear session (cache + Supabase) ────────────────────────────────────────
export async function clearSession() {
  try {
    // Stop sync
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
    
    // Wipe disk
    if (existsSync(CACHE_DIR)) {
      await rm(CACHE_DIR, { recursive: true, force: true });
    }
    
    // Wipe Supabase
    const sessionId = botConfig.BOT_NUMBER || "default";
    const { error } = await supabase
      .from("auth")
      .delete()
      .eq("session", sessionId);
    
    if (error) throw error;
    
    console.log("🗑️  Session cleared everywhere");
  } catch (err) {
    console.error("❌ Clear failed:", err.message);
  }
}

// ─── Clear ALL sessions ──────────────────────────────────────────────────────
export async function clearAllSessions() {
  try {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
    
    // Supabase
    await supabase.from("auth").delete();
    
    // All caches
    const cacheRoot = './sessions';
    if (existsSync(cacheRoot)) {
      await rm(cacheRoot, { recursive: true, force: true });
    }
    
    console.log("🗑️  All sessions wiped");
  } catch (err) {
    console.error("❌ Clear all failed:", err.message);
  }
}

// ─── Legacy ──────────────────────────────────────────────────────────────────
export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    await clearAllSessions();
  }
  return true;
}

export async function saveSession() {
  const sessionId = botConfig.BOT_NUMBER || "default";
  await syncToSupabase(sessionId);
  console.log("💾 Manual full sync complete");
}