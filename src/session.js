import { createClient } from "@supabase/supabase-js";
import { useRedisAuthStateWithHSet } from "baileys-redis-auth";
import { SUPABASE_URL, SUPABASE_KEY, botConfig } from "./config.js";
import Redis from "ioredis";

// Supabase kept for all non-session bot data (settings, admins, etc.)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Valkey/Redis connection ───────────────────────────────────────────────────
const REDIS_URL =
  process.env.REDIS_URL || process.env.VALKEY_URL || process.env.KV_URL;

function getRedisOptions() {
  if (REDIS_URL) {
    return { lazyConnect: true, maxRetriesPerRequest: 3 };
  }
  return {
    host: process.env.VALKEY_HOST || "127.0.0.1",
    port: parseInt(process.env.VALKEY_PORT || "6379"),
    password: process.env.VALKEY_PASSWORD || undefined,
    tls: process.env.VALKEY_TLS === "true" ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  };
}

// Standalone client for lock management, clearSession, and health checks
export const redisClient = REDIS_URL
  ? new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 })
  : new Redis(getRedisOptions());

redisClient.on("error", (err) => {
  console.error("❌ Valkey connection error:", err.message);
});

redisClient.on("connect", () => {
  console.log("✅ Valkey connected");
});

// ─── Session ID ───────────────────────────────────────────────────────────────
// CRITICAL: BOT_NUMBER must be set as a Koyeb env var.
// SESSION_ID() should never return "default" in production.
// If it does, getAuthState() will throw rather than silently use the wrong key.
export function SESSION_ID() {
  const id = botConfig.BOT_NUMBER || process.env.BOT_NUMBER;
  if (!id) {
    throw new Error(
      "BOT_NUMBER is not set. Add it as a Koyeb environment variable. " +
        "Without it, session keys will be stored under the wrong Redis hash."
    );
  }
  return id;
}

// ─── Session lock ─────────────────────────────────────────────────────────────
// Prevents multiple Koyeb instances from writing to the same Signal session
// simultaneously, which causes connectionReplaced (440) loops and key corruption.
const LOCK_TTL_SECONDS = 60;
let lockRenewalInterval = null;

export async function acquireSessionLock() {
  const lockKey = `${SESSION_ID()}:lock`;

  // NX = only set if not exists — atomic, no race window
  const acquired = await redisClient.set(
    lockKey,
    process.pid.toString(),
    "NX",
    "EX",
    LOCK_TTL_SECONDS
  );

  if (!acquired) {
    const owner = await redisClient.get(lockKey);
    console.warn(
      `⚠️  Session lock held by PID ${owner}. Another instance is active.`
    );
    return false;
  }

  console.log(`🔒 Session lock acquired (PID ${process.pid})`);

  // Renew lock every 30s so it never expires while the process is healthy
  lockRenewalInterval = setInterval(async () => {
    try {
      await redisClient.expire(lockKey, LOCK_TTL_SECONDS);
    } catch (err) {
      console.error("❌ Failed to renew session lock:", err.message);
    }
  }, 30_000);

  return true;
}

export async function releaseSessionLock() {
  if (lockRenewalInterval) {
    clearInterval(lockRenewalInterval);
    lockRenewalInterval = null;
  }
  try {
    await redisClient.del(`${SESSION_ID()}:lock`);
    console.log("🔓 Session lock released");
  } catch (err) {
    console.error("❌ Failed to release session lock:", err.message);
  }
}

// ─── Auth state ───────────────────────────────────────────────────────────────
// No longer cached globally — each call resolves to the correct session ID.
// Caching is handled internally by baileys-redis-auth per session.
//
// FIX: Original code used a global cachedAuthState that could bind permanently
// to "default" if called before BOT_NUMBER was populated. Removed entirely.
export async function getAuthState() {
  // 1. Verify Redis is reachable before handing state to Baileys
  try {
    await redisClient.ping();
  } catch (err) {
    throw new Error(`Redis health check failed before auth load: ${err.message}`);
  }

  const sessionId = SESSION_ID(); // throws if BOT_NUMBER missing
  const redisOptions = REDIS_URL ? REDIS_URL : getRedisOptions();

  const { state, saveCreds: rawSaveCreds } = await useRedisAuthStateWithHSet(
    redisOptions,
    sessionId,
    (msg) => console.log(`[Valkey] ${msg}`)
  );

  // 2. Integrity check — a partial Redis read (e.g. timeout mid-HGETALL)
  //    produces a state object that looks valid but is missing critical keys.
  //    Baileys will connect and immediately hit cryptographic failures.
  if (!state?.creds?.noiseKey || !state?.creds?.signedIdentityKey) {
    const hasAnyCreds = !!state?.creds;
    if (hasAnyCreds) {
      // Creds exist but are incomplete — likely corruption
      throw new Error(
        `Auth state loaded but is incomplete for session '${sessionId}'. ` +
          "Keys noiseKey or signedIdentityKey are missing. " +
          "Run clearSession() to force a fresh QR login."
      );
    }
    // No creds at all = fresh session, QR will be shown — this is fine
    console.log(`ℹ️  No existing session found for '${sessionId}'. QR login required.`);
  }

  // 3. Wrap saveCreds with error handling + debounce
  //    creds.update fires on every Signal ratchet step (every message).
  //    Silent failures here desync in-memory keys from Redis → Bad MAC errors.
  //    Debounce reduces Redis write pressure while trailing:true guarantees
  //    the final state is always persisted even after a burst.
  let saveTimer = null;
  let pendingSave = false;

  const saveCreds = async () => {
    // Always execute immediately if no pending timer (leading edge)
    if (!saveTimer) {
      try {
        await rawSaveCreds();
      } catch (err) {
        console.error(
          "🚨 CRITICAL: saveCreds failed — Signal keys may be out of sync:",
          err.message
        );
        // Do not silently continue. A failed save means the next restart
        // will load stale keys. Bubble the error so the caller can decide
        // whether to restart the process.
        throw err;
      }
    }

    pendingSave = true;

    if (saveTimer) clearTimeout(saveTimer);

    // Trailing save: always flush the latest state within 1.5s of last update
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (pendingSave) {
        pendingSave = false;
        try {
          await rawSaveCreds();
        } catch (err) {
          console.error(
            "🚨 CRITICAL: Trailing saveCreds failed:",
            err.message
          );
        }
      }
    }, 1500);
  };

  return { state, saveCreds };
}

// ─── Clear session ────────────────────────────────────────────────────────────
export async function clearSession() {
  try {
    const sessionId = SESSION_ID();
    await redisClient.del(`${sessionId}:auth`);
    console.log(`🗑️  Session '${sessionId}' cleared from Valkey`);
  } catch (err) {
    console.error("❌ Failed to clear Valkey session:", err.message);
    // Re-throw so callers can use finally {} to guarantee process.exit()
    // regardless of whether the delete succeeded.
    throw err;
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
  // No-op — baileys-redis-auth handles persistence automatically via saveCreds
}