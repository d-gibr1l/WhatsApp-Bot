import { useRedisAuthStateWithHSet } from "baileys-redis-auth";
import { botConfig } from "./config.js";
import Redis from "ioredis";

// ─── Redis connection ─────────────────────────────────────────────────────────

const REDIS_URL =
  process.env.REDIS_URL || process.env.VALKEY_URL || process.env.KV_URL;

function getRedisOptions() {
  if (REDIS_URL) return { lazyConnect: true, maxRetriesPerRequest: 3 };
  return {
    host:     process.env.VALKEY_HOST || "127.0.0.1",
    port:     parseInt(process.env.VALKEY_PORT || "6379", 10),
    password: process.env.VALKEY_PASSWORD || undefined,
    tls:      process.env.VALKEY_TLS === "true" ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  };
}

export const redisClient = REDIS_URL
  ? new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 })
  : new Redis(getRedisOptions());

redisClient.on("error", (err) => console.error("❌ Valkey error:", err.message));
redisClient.on("connect", () => console.log("✅ Valkey connected"));

// ─── Session ID ───────────────────────────────────────────────────────────────
// Throws if BOT_NUMBER not set — prevents silent use of "default" key in prod

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
// Prevents multiple Koyeb instances writing to the same Signal session.
// Uses unique INSTANCE_ID (not PID — every container is PID 1 on Koyeb).

const LOCK_TTL_SECONDS      = 20;
const LOCK_RENEW_INTERVAL   = 5_000;
const LOCK_ACQUIRE_RETRIES  = 15;
const LOCK_RETRY_DELAY      = 6_000;   // 6s × 15 = 90s total wait
const LOCK_FORCE_AFTER      = 12;      // force-take after ~72s

const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let lockRenewalInterval = null;

export async function acquireSessionLock() {
  const lockKey = `${SESSION_ID()}:lock`;

  for (let i = 1; i <= LOCK_ACQUIRE_RETRIES; i++) {
    const acquired = await redisClient.set(lockKey, INSTANCE_ID, "NX", "EX", LOCK_TTL_SECONDS);

    if (acquired) {
      console.log(`🔒 Session lock acquired (${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    const owner = await redisClient.get(lockKey);
    if (owner === INSTANCE_ID) {
      console.warn("⚠️  acquireSessionLock called twice — reusing lock.");
      return true;
    }

    const ttl = await redisClient.ttl(lockKey);
    console.warn(`⚠️  Lock held by ${owner} (TTL: ${ttl}s). Retry ${i}/${LOCK_ACQUIRE_RETRIES}...`);

    if (i >= LOCK_FORCE_AFTER) {
      console.warn(`⚠️  Force-taking lock after ${i} retries.`);
      await redisClient.set(lockKey, INSTANCE_ID, "EX", LOCK_TTL_SECONDS);
      console.log(`🔒 Lock force-acquired (${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY));
  }

  console.error("❌ Could not acquire session lock. Exiting.");
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
        console.error("❌ Lock ownership lost — another instance took over.");
        clearInterval(lockRenewalInterval);
        lockRenewalInterval = null;
      }
    } catch (err) {
      console.error("❌ Failed to renew lock:", err.message);
    }
  }, LOCK_RENEW_INTERVAL);
}

export async function releaseSessionLock() {
  if (lockRenewalInterval) { clearInterval(lockRenewalInterval); lockRenewalInterval = null; }
  try {
    const lockKey = `${SESSION_ID()}:lock`;
    const current = await redisClient.get(lockKey);
    if (current === INSTANCE_ID) {
      await redisClient.del(lockKey);
      console.log("🔓 Session lock released");
    } else {
      console.log("🔓 Lock already taken by another instance — skipping delete");
    }
  } catch (err) {
    console.error("❌ Failed to release lock:", err.message);
  }
}

// ─── Auth state ───────────────────────────────────────────────────────────────

export async function getAuthState() {
  try { await redisClient.ping(); } catch (err) {
    throw new Error(`Redis health check failed: ${err.message}`);
  }

  const sessionId = SESSION_ID();
  const redisOptions = REDIS_URL ? REDIS_URL : getRedisOptions();

  const { state, saveCreds: rawSaveCreds } = await useRedisAuthStateWithHSet(
    redisOptions,
    sessionId,
    (msg) => console.log(`[Valkey] ${msg}`)
  );

  // Integrity check — partial Redis reads produce incomplete state
  if (!state?.creds?.noiseKey || !state?.creds?.signedIdentityKey) {
    if (state?.creds) {
      throw new Error(
        `Auth state incomplete for '${sessionId}'. noiseKey or signedIdentityKey missing. ` +
        "Run clearSession() or set FORCE_FRESH_SESSION=true to re-login."
      );
    }
    console.log(`ℹ️  No session found for '${sessionId}'. QR login required.`);
  }

  // Debounced saveCreds — leading + trailing to balance write pressure vs integrity
  let saveTimer = null;
  let pendingSave = false;

  const saveCreds = async () => {
    if (!saveTimer) {
      try { await rawSaveCreds(); } catch (err) {
        console.error("🚨 saveCreds failed (leading):", err.message);
        throw err;
      }
    }
    pendingSave = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (pendingSave) {
        pendingSave = false;
        try { await rawSaveCreds(); } catch (err) {
          console.error("🚨 saveCreds failed (trailing):", err.message);
        }
      }
    }, 1500);
  };

  return { state, saveCreds };
}

// ─── Clear session ────────────────────────────────────────────────────────────

export async function clearSession() {
  const sessionId = SESSION_ID();
  await redisClient.del(`${sessionId}:auth`);
  await redisClient.del(`${sessionId}:lock`).catch(() => {});
  console.log(`🗑️  Session '${sessionId}' cleared from Valkey`);
}

// ─── Legacy stubs ─────────────────────────────────────────────────────────────

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    console.log("🆕 FORCE_FRESH_SESSION — clearing session");
    await clearSession();
  }
  return true;
}

export async function saveSession() { /* no-op */ }
