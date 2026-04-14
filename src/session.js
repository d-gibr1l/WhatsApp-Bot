// src/session.js
//
// Replaces the previous `baileys-redis-auth` dependency with a custom
// encrypted auth state backed by Supabase (source of truth) + Redis (cache).
//
// What changed vs the old session.js:
//  - Removed: baileys-redis-auth, useRedisAuthStateWithHSet, deleteHSetKeys
//  - Added: AES-256-GCM encryption of all session blobs before storage
//  - Added: Supabase as the persistent source of truth (uses existing project)
//  - Added: BufferJSON-correct serialization (fixes silent Buffer corruption)
//  - Added: Proper keys.get/keys.set implementation (was delegated to lib before)
//  - Added: In-memory write mutex preventing concurrent saveCreds races
//  - Kept: Redis session lock (acquireSessionLock / releaseSessionLock)
//  - Kept: loadSession / saveSession / clearSession API — index.js unchanged

import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { createClient }              from "@supabase/supabase-js";
import Redis                         from "ioredis";
import crypto                        from "crypto";
import { botConfig, SUPABASE_URL, SUPABASE_KEY } from "./config.js";

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Redis connection (same env vars as before) ───────────────────────────────

const REDIS_URL = process.env.REDIS_URL || process.env.VALKEY_URL || process.env.KV_URL;

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

redisClient.on("error",   (err) => console.error("Valkey error:",    err.message));
redisClient.on("connect", ()    => console.log("Valkey connected"));

// ─── Session ID ───────────────────────────────────────────────────────────────

export function SESSION_ID() {
  const id = botConfig.BOT_NUMBER || process.env.BOT_NUMBER;
  if (!id) throw new Error(
    "BOT_NUMBER is not set. Add it as a Koyeb environment variable."
  );
  return id;
}

// ─── AES-256-GCM Encryption ───────────────────────────────────────────────────
// SESSION_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).
// Generate: openssl rand -hex 32
// If unset, blobs are stored as plaintext (migration mode — add key + redeploy).

function getEncryptionKey() {
  const hex = process.env.SESSION_ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) throw new Error(
    "SESSION_ENCRYPTION_KEY must be 64 hex characters. Generate: openssl rand -hex 32"
  );
  return Buffer.from(hex, "hex");
}

function encryptBlob(plaintext) {
  const key = getEncryptionKey();
  if (!key) return plaintext; // migration mode
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag       = cipher.getAuthTag();
  return [iv, tag, encrypted].map(b => b.toString("base64")).join(":");
}

function decryptBlob(stored) {
  const key = getEncryptionKey();
  if (!key || !stored.includes(":")) return stored; // plaintext migration mode
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return decipher.update(Buffer.from(dataB64, "base64"), undefined, "utf8") + decipher.final("utf8");
}

// ─── Supabase session table ───────────────────────────────────────────────────
// Required table (run once in Supabase SQL editor):
//
//   CREATE TABLE wa_sessions (
//     id         TEXT PRIMARY KEY,
//     data       TEXT NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT now()
//   );
//   -- Enable RLS if needed, or keep it service-role only

let tableWarned = false;

async function dbLoad(sessionId) {
  const { data, error } = await supabase
    .from("wa_sessions")
    .select("data")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01" && !tableWarned) {
      tableWarned = true;
      console.warn(
        "\n⚠️  wa_sessions table missing. Run in Supabase SQL editor:\n\n" +
        "  CREATE TABLE wa_sessions (\n" +
        "    id TEXT PRIMARY KEY,\n" +
        "    data TEXT NOT NULL,\n" +
        "    updated_at TIMESTAMPTZ DEFAULT now()\n" +
        "  );\n"
      );
    } else if (error.code !== "42P01") {
      console.error("Session DB load error:", error.message);
    }
    return null;
  }
  return data?.data ?? null;
}

async function dbSave(sessionId, blob) {
  const { error } = await supabase
    .from("wa_sessions")
    .upsert(
      { id: sessionId, data: blob, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  if (error) throw new Error(`Session DB save failed: ${error.message}`);
}

async function dbDelete(sessionId) {
  const { error } = await supabase
    .from("wa_sessions")
    .delete()
    .eq("id", sessionId);
  if (error) console.error("Session DB delete error:", error.message);
}

// ─── Redis cache helpers ──────────────────────────────────────────────────────

const SESSION_TTL  = 86400; // 24h
const CACHE_PREFIX = "sess:";

async function cacheGet(sessionId) {
  try   { return await redisClient.get(`${CACHE_PREFIX}${sessionId}`); }
  catch { return null; }
}

async function cacheSet(sessionId, blob) {
  try   { await redisClient.set(`${CACHE_PREFIX}${sessionId}`, blob, "EX", SESSION_TTL); }
  catch {}
}

async function cacheDel(sessionId) {
  try   { await redisClient.del(`${CACHE_PREFIX}${sessionId}`); }
  catch {}
}

// ─── Session validation ───────────────────────────────────────────────────────

function validateCreds(creds) {
  if (!creds?.noiseKey)          throw new Error("missing creds.noiseKey");
  if (!creds?.signedIdentityKey) throw new Error("missing creds.signedIdentityKey");
}

// ─── Load / save helpers ──────────────────────────────────────────────────────

async function loadSessionData(sessionId) {
  // L1: Redis
  const cached = await cacheGet(sessionId);
  if (cached) {
    try {
      return JSON.parse(decryptBlob(cached), BufferJSON.reviver);
    } catch (err) {
      console.warn(`Redis blob invalid for '${sessionId}': ${err.message} — falling to DB`);
      await cacheDel(sessionId);
    }
  }

  // L2: Supabase
  const blob = await dbLoad(sessionId);
  if (!blob) return null;

  try {
    const data = JSON.parse(decryptBlob(blob), BufferJSON.reviver);
    cacheSet(sessionId, blob).catch(() => {}); // re-warm Redis async
    return data;
  } catch (err) {
    console.error(`DB blob corrupt for '${sessionId}': ${err.message}`);
    return null;
  }
}

async function saveSessionData(sessionId, data) {
  const blob = encryptBlob(JSON.stringify(data, BufferJSON.replacer));
  await dbSave(sessionId, blob);   // DB first — source of truth
  await cacheSet(sessionId, blob); // Redis second — cache
}

// ─── In-memory write mutex ────────────────────────────────────────────────────

const writeLocks = new Map();

async function withWriteLock(sessionId, fn) {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve();
  let release;
  const lease = new Promise(r => { release = r; });
  writeLocks.set(sessionId, prev.then(() => lease));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (writeLocks.get(sessionId) === lease) writeLocks.delete(sessionId);
  }
}

// ─── Auth state cache ─────────────────────────────────────────────────────────

let authStateCache = null;

export async function getAuthState() {
  try { await redisClient.ping(); } catch (err) {
    throw new Error(`Redis health check failed: ${err.message}`);
  }

  const sessionId = SESSION_ID();

  if (authStateCache?.sessionId === sessionId) {
    return { state: authStateCache.state, saveCreds: authStateCache.saveCreds };
  }

  console.log(`Loading session '${sessionId}'...`);
  const stored = await loadSessionData(sessionId);

  let creds = stored?.creds ?? initAuthCreds();
  const keys = stored?.keys ?? {};

  if (stored?.creds) {
    try {
      validateCreds(creds);
    } catch (err) {
      if (process.env.FORCE_FRESH_SESSION !== "true") {
        throw new Error(
          `Auth state incomplete for '${sessionId}': ${err.message}. ` +
          "Set FORCE_FRESH_SESSION=true to re-login."
        );
      }
      console.warn(`Incomplete session — forcing fresh login`);
      creds = initAuthCreds();
    }
  } else {
    console.log(`No session found for '${sessionId}'. QR login required.`);
  }

  // ── Debounced saveCreds ────────────────────────────────────────────────────
  // Leading edge  : write immediately (captures QR-scan creds quickly)
  // Trailing edge : guarantees the final Signal ratchet is always flushed

  let saveTimer   = null;
  let pendingSave = false;

  const flushSave = () =>
    withWriteLock(sessionId, () => saveSessionData(sessionId, { creds, keys }));

  const saveCreds = async () => {
    if (!saveTimer) {
      try { await flushSave(); } catch (err) {
        console.error("saveCreds failed (leading):", err.message);
        throw err;
      }
    }
    pendingSave = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (pendingSave) {
        pendingSave = false;
        try { await flushSave(); } catch (err) {
          console.error("saveCreds failed (trailing):", err.message);
        }
      }
    }, 1500);
  };

  const state = {
    creds,
    keys: {
      // Returns requested keys, re-applying BufferJSON.reviver to restore Buffers
      get(type, ids) {
        const result = {};
        for (const id of ids) {
          const val = keys[`${type}-${id}`];
          if (val !== undefined) {
            result[id] = JSON.parse(JSON.stringify(val), BufferJSON.reviver);
          }
        }
        return result;
      },

      // Merges Baileys key updates into memory + debounces the DB write
      // (key rotation fires 5-10x per message — 150ms debounce collapses them)
      set(data) {
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const val = data[category][id];
            const key = `${category}-${id}`;
            if (val != null) {
              keys[key] = JSON.parse(JSON.stringify(val, BufferJSON.replacer));
            } else {
              delete keys[key];
            }
          }
        }
        if (saveTimer) clearTimeout(saveTimer);
        pendingSave = true;
        saveTimer = setTimeout(async () => {
          saveTimer = null;
          if (pendingSave) {
            pendingSave = false;
            try { await flushSave(); } catch (err) {
              console.error("keys.set save failed:", err.message);
            }
          }
        }, 150);
      }
    }
  };

  authStateCache = { sessionId, state, saveCreds };
  return { state, saveCreds };
}

// ─── Session lock (unchanged from original — index.js depends on this API) ────

const LOCK_TTL_SECONDS     = 20;
const LOCK_RENEW_INTERVAL  = 5_000;
const LOCK_ACQUIRE_RETRIES = 15;
const LOCK_RETRY_DELAY     = 6_000;
const LOCK_FORCE_AFTER     = 12;

const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let lockRenewalInterval = null;

export async function acquireSessionLock() {
  const lockKey = `${SESSION_ID()}:lock`;

  for (let i = 1; i <= LOCK_ACQUIRE_RETRIES; i++) {
    const acquired = await redisClient.set(lockKey, INSTANCE_ID, "NX", "EX", LOCK_TTL_SECONDS);
    if (acquired) {
      console.log(`Session lock acquired (${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    const owner = await redisClient.get(lockKey);
    if (owner === INSTANCE_ID) return true;

    const ttl = await redisClient.ttl(lockKey);
    console.warn(`Lock held by ${owner} (TTL: ${ttl}s). Retry ${i}/${LOCK_ACQUIRE_RETRIES}...`);

    if (i >= LOCK_FORCE_AFTER) {
      console.warn(`Force-taking lock after ${i} retries.`);
      await redisClient.set(lockKey, INSTANCE_ID, "EX", LOCK_TTL_SECONDS);
      console.log(`Lock force-acquired (${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY));
  }

  console.error("Could not acquire session lock after all retries.");
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
        console.error("Lock ownership lost — another instance took over.");
        clearInterval(lockRenewalInterval);
        lockRenewalInterval = null;
      }
    } catch (err) {
      console.error("Failed to renew lock:", err.message);
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
      console.log("Session lock released");
    } else {
      console.log("Lock already taken by another instance — skipping delete");
    }
  } catch (err) {
    console.error("Failed to release lock:", err.message);
  }
}

// ─── Public API (same as old session.js) ─────────────────────────────────────

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    console.log("FORCE_FRESH_SESSION — clearing session");
    await clearSession();
  }
  return true;
}

export async function clearSession() {
  authStateCache = null;
  const sessionId = SESSION_ID();
  await Promise.allSettled([
    dbDelete(sessionId),
    cacheDel(sessionId),
  ]);
  console.log(`Session '${sessionId}' cleared`);
}

export async function saveSession() { /* no-op: saves happen via saveCreds */ }
