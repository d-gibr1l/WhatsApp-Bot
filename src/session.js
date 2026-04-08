import { createClient } from "@supabase/supabase-js";
import { useRedisAuthStateWithHSet, deleteHSetKeys } from "baileys-redis-auth";
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
//
// WHY NOT PID: On Koyeb (and most container platforms), every container runs
// as PID 1. Storing process.pid in the lock is useless — the new instance
// sees "1" in the lock and cannot tell if that's the dead previous container
// or itself. We use a per-boot unique instance ID instead.
//
// WHY SHORT TTL: With a 60s TTL, a deploy that kills the old container without
// cleanly releasing the lock causes the new instance to spin-exit for up to
// 60s until the lock expires — enough for Koyeb to mark the deploy as failed.
// 15s TTL + 5s renewal interval means a dead instance's lock expires in at
// most 15s. A healthy instance renews every 5s, so it never expires in use.

const LOCK_TTL_SECONDS = 20;
const LOCK_RENEW_INTERVAL_MS = 5_000;

// Koyeb rolling deploys keep the old instance alive until the new one passes
// health checks — typically 30-60s. We retry for up to ~90s total to outlast
// the overlap window. If the old instance is still alive after 90s, something
// is wrong and we force-take the lock (it should have received SIGTERM by then).
const LOCK_ACQUIRE_RETRIES  = 15;     // 15 retries
const LOCK_RETRY_DELAY_MS   = 6_000;  // 6s apart = 90s total wait
const LOCK_FORCE_AFTER_RETRY = 12;    // force-take after 12 retries (~72s)

// Unique ID for this specific boot — survives reconnects within the same process
// but differs from every other container even if they share PID 1.
const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let lockRenewalInterval = null;

export async function acquireSessionLock() {
  const lockKey = `${SESSION_ID()}:lock`;

  for (let attempt = 1; attempt <= LOCK_ACQUIRE_RETRIES; attempt++) {
    // NX = only set if not exists — atomic, no race window
    const acquired = await redisClient.set(
      lockKey,
      INSTANCE_ID,
      "NX",
      "EX",
      LOCK_TTL_SECONDS
    );

    if (acquired) {
      console.log(`🔒 Session lock acquired (instance ${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    // Lock is held by another instance
    const owner = await redisClient.get(lockKey);

    // Detect if we somehow called this twice in the same process
    if (owner === INSTANCE_ID) {
      console.warn("⚠️  acquireSessionLock called twice in same instance — reusing lock.");
      return true;
    }

    const ttl = await redisClient.ttl(lockKey);
    console.warn(
      `⚠️  Lock held by instance ${owner} (TTL: ${ttl}s). ` +
      `Retry ${attempt}/${LOCK_ACQUIRE_RETRIES} in ${LOCK_RETRY_DELAY_MS / 1000}s...`
    );

    // Force-take after LOCK_FORCE_AFTER_RETRY attempts.
    // At this point we've waited ~72s — the old instance should have received
    // SIGTERM from Koyeb and be dead or dying. If it's still renewing the lock,
    // it's a zombie. Taking the lock is safer than never connecting.
    if (attempt >= LOCK_FORCE_AFTER_RETRY) {
      console.warn(
        `⚠️  Force-taking session lock after ${attempt} retries. ` +
        `Old instance (${owner}) did not release within expected window.`
      );
      await redisClient.set(lockKey, INSTANCE_ID, "EX", LOCK_TTL_SECONDS);
      console.log(`🔒 Session lock force-acquired (instance ${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
  }

  // Should never reach here given force-take above, but guard anyway
  console.error("❌ Could not acquire session lock after all retries. Exiting.");
  return false;
}

function startLockRenewal(lockKey) {
  if (lockRenewalInterval) clearInterval(lockRenewalInterval);

  lockRenewalInterval = setInterval(async () => {
    try {
      const current = await redisClient.get(lockKey);
      if (current === INSTANCE_ID) {
        await redisClient.expire(lockKey, LOCK_TTL_SECONDS);
      } else {
        console.error("❌ Lock ownership lost during renewal — another instance took over.");
        clearInterval(lockRenewalInterval);
        lockRenewalInterval = null;
      }
    } catch (err) {
      console.error("❌ Failed to renew session lock:", err.message);
    }
  }, LOCK_RENEW_INTERVAL_MS);
}

export async function releaseSessionLock() {
  if (lockRenewalInterval) {
    clearInterval(lockRenewalInterval);
    lockRenewalInterval = null;
  }
  try {
    // Only delete if we still own it — avoids accidentally releasing a lock
    // that another instance acquired after ours expired.
    const lockKey = `${SESSION_ID()}:lock`;
    const current = await redisClient.get(lockKey);
    if (current === INSTANCE_ID) {
      await redisClient.del(lockKey);
      console.log("🔓 Session lock released");
    } else {
      console.log("🔓 Lock already taken by another instance — skipping delete");
    }
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

    // deleteHSetKeys is the library's own cleanup utility.
    // redisClient.del(`${sessionId}:auth`) only removes the top-level hash key.
    // If baileys-redis-auth manages additional keys per session in future versions,
    // del would silently miss them. deleteHSetKeys handles all associated keys correctly.
    await deleteHSetKeys({ redis: redisClient, key: sessionId });

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
