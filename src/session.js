import { createClient } from "@supabase/supabase-js";
import { useRedisAuthStateWithHSet } from "baileys-redis-auth";
import { SUPABASE_URL, SUPABASE_KEY, botConfig } from "./config.js";
import Redis from "ioredis";

// Supabase kept for all non-session bot data (settings, admins, etc.)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Valkey/Redis connection ───────────────────────────────────────────────────
// Koyeb injects REDIS_URL or VALKEY_URL automatically when addon is attached
const REDIS_URL = process.env.REDIS_URL || process.env.VALKEY_URL || process.env.KV_URL;

function getRedisOptions() {
  if (REDIS_URL) {
    return { lazyConnect: true, maxRetriesPerRequest: 3 };
  }
  // Fallback to individual env vars
  return {
    host:     process.env.VALKEY_HOST || "127.0.0.1",
    port:     parseInt(process.env.VALKEY_PORT || "6379"),
    password: process.env.VALKEY_PASSWORD || undefined,
    tls:      process.env.VALKEY_TLS === "true" ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  };
}

// Standalone client for manual operations (clearSession)
const redisClient = REDIS_URL
  ? new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 })
  : new Redis(getRedisOptions());

redisClient.on("error", (err) => {
  console.error("❌ Valkey connection error:", err.message);
});

// ─── Get auth state — Valkey ──────────────────────────────────────────────────
// All Signal encryption keys stored in Redis HSET — sub-millisecond reads/writes
// Completely eliminates the Bad MAC race condition from disk/network latency

export async function getAuthState() {
  const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default";

  const redisOptions = REDIS_URL ? REDIS_URL : getRedisOptions();

  const { state, saveCreds } = await useRedisAuthStateWithHSet(
    redisOptions,
    sessionId,
    (msg) => console.log(`[Valkey] ${msg}`)
  );

  return { state, saveCreds };
}

// ─── Clear session ────────────────────────────────────────────────────────────
export async function clearSession() {
  try {
    const sessionId = botConfig.BOT_NUMBER || process.env.BOT_NUMBER || "default";
    await redisClient.del(`${sessionId}:auth`);
    console.log(`🗑️ Session '${sessionId}' cleared from Valkey`);
  } catch (err) {
    console.error("❌ Failed to clear Valkey session:", err.message);
  }
}

// ─── Legacy stubs ─────────────────────────────────────────────────────────────
export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    console.log("🆕 FORCE_FRESH_SESSION — clearing session");
    await clearSession();
  }
  return true;
}

export async function saveSession() {
  // No-op — baileys-redis-auth handles persistence automatically
}
