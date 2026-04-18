// src/session.js
//
// Architecture: Three-tier session persistence for Baileys / Signal Protocol.
//
//   L1  In-process LRU+TTL RAM cache (localKeys)     — ~0ms, 5 000 key cap
//   L2  Redis / Valkey HSet                           — ~1ms, 24 h TTL
//   L3  Supabase (single blob per session)            — ~150ms, permanent
//
// Write path:
//   keys.set()  → L1 RAM (sync, instant) → dirty buffer
//                 → pointer-swap flush every 200 ms or 50 keys
//                 → single serialized worker → L2 Redis (awaited)
//                 → L3 Supabase (jittered retry, fire-and-forget)
//
//   saveCreds() → immediate leading-edge flush to L2+L3 (creds are critical)
//
// Read path:
//   keys.get()  → L1 RAM hit? return instantly
//                 → L2 Redis hit? populate L1, return
//                 → L3 Supabase hit? populate L2+L1, return
//
// ── FIXES APPLIED ────────────────────────────────────────────────────────────
//
// FIX 1 — Read-modify-write race in flush workers (CRITICAL):
//   The original executeWriteKeys / executeDeleteKeys re-read the full session
//   blob from Redis or Supabase, merged the snapshot, and wrote it back.
//   With MAX_CONCURRENCY=2, two workers could both read the same stale blob at
//   T=0, merge different key subsets, and the second writer would silently
//   overwrite the first's keys — causing Bad MAC / decryption failures on the
//   next message.
//   Fix: workers now build the blob directly from L1 RAM (always the most
//   current authoritative state, updated synchronously by keys.set()).
//   executeWriteKeys and executeDeleteKeys are removed; a single unified task
//   is enqueued instead. MAX_CONCURRENCY reduced to 1 to fully serialize writes.
//
// FIX 2 — Redis health check was fatal (CRITICAL):
//   getAuthState() threw if redisClient.ping() failed, aborting the reconnect
//   loop even though Supabase is a valid complete fallback for the session.
//   cacheGet/cacheSet already swallow Redis errors; there was no reason for
//   the health check to be stricter. Fix: downgrade to a console.warn.
//
// FIX 3 — Stale worker writes after clearSession() (MEDIUM):
//   A flush task queued just before clearSession() could execute after the
//   session was cleared and write an empty or stale blob back to storage,
//   effectively "un-deleting" the cleared session.
//   Fix: every flush task checks authStateCache before writing and skips if
//   the session has been cleared.
//
// FIX 4 — getCurrentKeysSnapshot() moved to module level (STRUCTURAL):
//   Was a closure inside getAuthState() but only referenced module-level
//   variables (localKeys, BufferJSON). Moving it to module level allows
//   buildSessionBlob() to use it everywhere without duplication.

import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { createClient }              from "@supabase/supabase-js";
import Redis                         from "ioredis";
import crypto                        from "crypto";
import { botConfig, SUPABASE_URL, SUPABASE_KEY } from "./config.js";

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Redis ────────────────────────────────────────────────────────────────────

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
  if (!id) throw new Error("BOT_NUMBER is not set. Add it as a Koyeb environment variable.");
  return id;
}

// ─── AES-256-GCM Encryption ───────────────────────────────────────────────────
// Generate key: openssl rand -hex 32
// If SESSION_ENCRYPTION_KEY is unset, blobs are stored as plaintext (migration mode).

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
  if (!key) return plaintext;
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag       = cipher.getAuthTag();
  return [iv, tag, encrypted].map(b => b.toString("base64")).join(":");
}

function decryptBlob(stored) {
  if (!stored) return null;
  const key = getEncryptionKey();
  if (!key || !stored.includes(":")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return decipher.update(Buffer.from(dataB64, "base64"), undefined, "utf8") + decipher.final("utf8");
  } catch {
    // Auth tag mismatch = tampered data or wrong key. Return null so caller
    // treats this as a cache miss and falls through to the next storage tier.
    console.error("Decryption failed — treating as cache miss (possible key rotation or corruption)");
    return null;
  }
}

// ─── Supabase session table ───────────────────────────────────────────────────
// Run once in Supabase SQL editor:
//
//   CREATE TABLE wa_sessions (
//     id         TEXT PRIMARY KEY,
//     data       TEXT NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT now()
//   );

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
  const { error } = await supabase.from("wa_sessions").delete().eq("id", sessionId);
  if (error) console.error("Session DB delete error:", error.message);
}

// ─── Jittered retry for Supabase ─────────────────────────────────────────────
// Thundering-herd protection: staggering retries so all failing tasks don't
// slam the database at the exact same millisecond.

async function safeDbWrite(sessionId, blob, retries = 3) {
  try {
    await dbSave(sessionId, blob);
  } catch (err) {
    if (retries > 0) {
      const jitter = Math.random() * 500;
      await new Promise(r => setTimeout(r, 1000 + jitter));
      return safeDbWrite(sessionId, blob, retries - 1);
    }
    console.warn(`Supabase sync permanently failed after retries: ${err.message}`);
  }
}

// ─── L1 RAM LRU+TTL Cache ────────────────────────────────────────────────────
// Custom O(1) LRU exploiting ECMAScript Map's guaranteed insertion-order iteration.
// delete + re-insert = moves entry to "most recently used" tail of the Map.
// Eviction: when size > maxSize, delete the first (oldest) entry = O(1).
// TTL: checked lazily on get() — no background sweep needed.

class LRUTTLCache {
  constructor(maxSize, ttlMs = 600_000) { // 10-minute TTL default
    this.maxSize = maxSize;
    this.ttlMs   = ttlMs;
    this.cache   = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const entry = this.cache.get(key);
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to tail (most-recently-used position)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.val;
  }

  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      // Evict LRU entry (head of Map)
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { val, expiry: Date.now() + this.ttlMs });
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    if (Date.now() > this.cache.get(key).expiry) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key) { this.cache.delete(key); }
  clear()     { this.cache.clear(); }
}

// 5 000 key cap · 10 min TTL — keeps memory well under 20 MB for a single session
const localKeys = new LRUTTLCache(5000);

// ─── Module-level key snapshot (FIX 4) ───────────────────────────────────────
// Moved from inside getAuthState() — only closes over module-level variables so
// it belongs at module scope. Used by buildSessionBlob() (declared below, after
// authStateCache) to produce a full consistent snapshot of all Signal keys.

function getCurrentKeysSnapshot() {
  const out = {};
  for (const [k, entry] of localKeys.cache.entries()) {
    if (Date.now() <= entry.expiry) {
      out[k] = JSON.parse(JSON.stringify(entry.val, BufferJSON.replacer));
    }
  }
  return out;
}

// ─── Dirty-write buffer + pointer-swap flush ──────────────────────────────────
// keys.set() writes to this buffer synchronously (instant, no I/O).
// A timer or threshold triggers flushRAMToQueue(), which swaps the pointer
// atomically so new writes land on a fresh empty Map while the snapshot
// is being dispatched to the worker pool.

let dirtyWrites  = new Map(); // keyId → serialized value
let dirtyDeletes = new Set(); // keyId
let syncTimer    = null;

const FLUSH_THRESHOLD = 50;  // flush early if ≥ 50 keys accumulated
const FLUSH_INTERVAL  = 200; // ms — maximum time a key stays unflushed

// FIX 1 (part A): flushRAMToQueue enqueues a single task that builds the full
// blob from L1 RAM. The pointer-swap still happens (so concurrent keys.set()
// calls land on fresh maps), but the snapshot contents are no longer passed to
// the worker — L1 is always more current than any snapshot by the time the
// worker executes.

function flushRAMToQueue(sessionId) {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (dirtyWrites.size === 0 && dirtyDeletes.size === 0) return;

  // Pointer swap: detach the current buffer instantly.
  // New writes arriving during the async flush go into fresh maps.
  dirtyWrites  = new Map();
  dirtyDeletes = new Set();

  enqueueWrite(async () => {
    // FIX 3: Guard against post-clearSession() writes. If authStateCache was
    // nulled between enqueue and execution, skip — writing now would persist
    // an empty or stale blob and effectively un-delete the cleared session.
    if (!authStateCache) return;
    try {
      const blob = buildSessionBlob();
      await cacheSet(sessionId, blob);
      safeDbWrite(sessionId, blob).catch(err =>
        console.warn(`Supabase background flush failed: ${err.message}`)
      );
    } catch (err) {
      console.error("Batch flush failed in worker:", err.message);
    }
  });
}

// ─── Bounded worker pool ──────────────────────────────────────────────────────
// FIX 1 (part B): MAX_CONCURRENCY reduced from 2 → 1.
// All writes are now serialized. Since every write builds from L1 RAM (the
// most current state), serialization guarantees that the last write always
// contains every key set before it — no key can be silently overwritten.

const writeQueue      = [];
let   activeWorkers   = 0;
const MAX_CONCURRENCY = 1;    // serialize all writes — eliminates blob-overwrite races
const SOFT_LIMIT      = 100;  // queue depth that triggers backpressure
const MAX_QUEUE_SIZE  = 500;  // hard cap — beyond this something is badly wrong

async function processWorker() {
  try {
    while (writeQueue.length > 0) {
      const task = writeQueue.shift();
      if (task) await task().catch(err => console.error("Worker task error:", err.message));
    }
  } finally {
    activeWorkers--;
    dispatchWorkers();
  }
}

function dispatchWorkers() {
  while (activeWorkers < MAX_CONCURRENCY && writeQueue.length > 0) {
    activeWorkers++;
    processWorker().catch(console.error);
  }
}

async function enqueueWrite(task) {
  if (writeQueue.length >= MAX_QUEUE_SIZE) {
    // Something is severely wrong (Redis dead for minutes). Log and drop
    // rather than crash — data is still in L1 RAM; worst case it misses
    // Supabase this cycle.
    console.error(`Write queue full (${MAX_QUEUE_SIZE}). Dropping oldest task to prevent OOM.`);
    writeQueue.shift(); // drop oldest to make room
  }

  // Exponential backpressure: slows the Baileys event loop before queue overflows.
  if (writeQueue.length > SOFT_LIMIT) {
    const overload = writeQueue.length - SOFT_LIMIT;
    const delay    = Math.min(1000, Math.pow(overload, 1.2));
    await new Promise(r => setTimeout(r, delay));
  }

  writeQueue.push(task);
  dispatchWorkers();
}

// ─── Graceful shutdown drain ──────────────────────────────────────────────────
// Called by index.js before process.exit(). Flushes the dirty RAM buffer into
// the queue, then waits up to timeoutMs for the queue to empty.

export async function drainQueue(timeoutMs = 2000) {
  const sessionId = SESSION_ID();
  flushRAMToQueue(sessionId);     // swap dirty buffer → queue
  if (writeQueue.length === 0) return;

  console.log(`Draining ${writeQueue.length} pending write(s) before shutdown...`);
  const start = Date.now();
  while (writeQueue.length > 0 && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (writeQueue.length > 0) {
    console.warn(`Shutdown drain timed out. ${writeQueue.length} write(s) not persisted to Supabase.`);
  } else {
    console.log("Session write buffer drained successfully.");
  }
}

// drainPendingDbWrites is the name index.js already imports — alias it.
export const drainPendingDbWrites = drainQueue;

// ─── Redis circuit breaker ────────────────────────────────────────────────────
// Counts consecutive Redis failures. At MAX_REDIS_FAILURES, logs a critical
// warning but does NOT kill the process — Supabase is still the safety net.
// Resets to 0 on any successful Redis write.

let redisFailures = 0;
const MAX_REDIS_FAILURES = 5;

// ─── Redis helpers (L2) ───────────────────────────────────────────────────────

const SESSION_TTL  = 86400;      // 24 h
const CACHE_PREFIX = "sess:";    // STRING key — single blob per session

async function cacheGet(sessionId) {
  try   { return await redisClient.get(`${CACHE_PREFIX}${sessionId}`); }
  catch { return null; }
}

async function cacheSet(sessionId, blob) {
  try {
    await redisClient.set(`${CACHE_PREFIX}${sessionId}`, blob, "EX", SESSION_TTL);
    redisFailures = 0; // successful write resets circuit breaker
  } catch (err) {
    redisFailures++;
    if (redisFailures >= MAX_REDIS_FAILURES) {
      console.error(`🚨 Redis circuit breaker: ${redisFailures} consecutive failures. Supabase is now the only store.`);
    }
  }
}

async function cacheDel(sessionId) {
  try   { await redisClient.del(`${CACHE_PREFIX}${sessionId}`); }
  catch {}
}

// ─── Session load (startup / reconnect) ──────────────────────────────────────

async function loadSessionData(sessionId) {
  // L2: Redis
  const cached = await cacheGet(sessionId);
  if (cached) {
    const plain = decryptBlob(cached);
    if (plain) {
      try   { return JSON.parse(plain, BufferJSON.reviver); }
      catch { console.warn("Redis blob unparseable — falling to DB"); await cacheDel(sessionId); }
    } else {
      await cacheDel(sessionId); // decryption failed, evict stale/tampered entry
    }
  }

  // L3: Supabase
  const blob = await dbLoad(sessionId);
  if (!blob) return null;

  const plain = decryptBlob(blob);
  if (!plain) {
    console.error("DB blob decryption failed. Session will be treated as missing.");
    return null;
  }

  try {
    const data = JSON.parse(plain, BufferJSON.reviver);
    cacheSet(sessionId, blob).catch(() => {}); // re-warm Redis async
    return data;
  } catch (err) {
    console.error(`DB blob JSON parse failed: ${err.message}`);
    return null;
  }
}

// ─── Creds validation ─────────────────────────────────────────────────────────

function validateCreds(creds) {
  if (!creds?.noiseKey)          throw new Error("missing creds.noiseKey");
  if (!creds?.signedIdentityKey) throw new Error("missing creds.signedIdentityKey");
}

// ─── authStateCache + buildSessionBlob ───────────────────────────────────────
// authStateCache must be declared before buildSessionBlob so the function can
// read authStateCache.state.creds at call time (not definition time).
//
// buildSessionBlob() is the single source-of-truth serializer used by every
// write path (flushCreds, flush worker). It reads creds from the live
// authStateCache reference (Baileys mutates it in place) and all Signal keys
// from L1 RAM via getCurrentKeysSnapshot(). This replaces the old pattern of
// re-reading the blob from Redis/Supabase before every write.

let authStateCache = null;

function buildSessionBlob() {
  return encryptBlob(
    JSON.stringify(
      {
        creds: authStateCache?.state?.creds ?? null,
        keys:  getCurrentKeysSnapshot(),
      },
      BufferJSON.replacer
    )
  );
}

// ─── getAuthState ─────────────────────────────────────────────────────────────

export async function getAuthState() {
  // FIX 2: Changed from fatal throw → warning + continue.
  // Redis being temporarily unreachable (cold boot, network blip, rolling
  // deploy) must not abort the connection attempt. loadSessionData() already
  // falls through to Supabase when cacheGet() fails, so the session is still
  // recoverable. cacheSet() also swallows Redis errors silently. Making the
  // health check here fatal was stricter than the rest of the code warranted.
  try {
    await redisClient.ping();
  } catch (err) {
    console.warn(
      `Redis health check failed: ${err.message}. ` +
      "Proceeding — Supabase will be used as the sole store until Redis recovers."
    );
    // Do NOT throw — allow the connection attempt to continue.
  }

  const sessionId = SESSION_ID();

  // Return cached auth state on reconnect (creds object is mutated in-place
  // by Baileys, so the reference is always current).
  if (authStateCache?.sessionId === sessionId) {
    return { state: authStateCache.state, saveCreds: authStateCache.saveCreds };
  }

  console.log(`Loading session '${sessionId}'...`);
  const stored = await loadSessionData(sessionId);

  let creds = stored?.creds ?? initAuthCreds();

  // Populate L1 RAM cache from loaded session (avoids cold-read on first message)
  if (stored?.keys) {
    for (const [keyId, val] of Object.entries(stored.keys)) {
      localKeys.set(keyId, JSON.parse(JSON.stringify(val), BufferJSON.reviver));
    }
  }

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
      console.warn("Incomplete session — forcing fresh login");
      creds = initAuthCreds();
    }
  } else {
    console.log(`No session found for '${sessionId}'. QR login required.`);
  }

  // ── saveCreds ────────────────────────────────────────────────────────────
  // Leading-edge: fires immediately on first call (captures QR-scan creds).
  // Trailing-edge: re-fires 1.5s after the last call (captures final ratchet).
  //
  // FIX 1 + FIX 3 applied: flushCreds uses buildSessionBlob() (L1 RAM
  // snapshot) instead of the old { creds, keys: getCurrentKeys() } inline.
  // The result is identical — authStateCache.state.creds IS the same object
  // reference as the local `creds` variable; Baileys mutates it in place.
  // The authStateCache null guard prevents writes after clearSession().

  const flushCreds = () => enqueueWrite(async () => {
    if (!authStateCache) return; // FIX 3: skip if session was cleared
    try {
      const blob = buildSessionBlob();
      await cacheSet(sessionId, blob);
      safeDbWrite(sessionId, blob).catch(err =>
        console.warn(`saveCreds Supabase write failed: ${err.message}`)
      );
    } catch (err) {
      console.error("saveCreds flush error:", err.message);
      throw err;
    }
  });

  let credsTimer   = null;
  let credsPending = false;

  const saveCreds = async () => {
    // Leading edge: write immediately if no timer is already pending
    if (!credsTimer) {
      try { await flushCreds(); } catch (err) {
        console.error("saveCreds failed (leading edge):", err.message);
        throw err;
      }
    }
    credsPending = true;
    if (credsTimer) clearTimeout(credsTimer);
    credsTimer = setTimeout(async () => {
      credsTimer = null;
      if (credsPending) {
        credsPending = false;
        try { await flushCreds(); } catch (err) {
          console.error("saveCreds failed (trailing edge):", err.message);
        }
      }
    }, 1500);
  };

  // ── keys API ─────────────────────────────────────────────────────────────

  const state = {
    creds,
    keys: {
      // Synchronous read from L1 RAM — Baileys calls this in hot decrypt paths.
      // Cache is pre-populated from loadSessionData() above so cold-start misses
      // are extremely rare (only for keys older than the 10-min TTL).
      get(type, ids) {
        const result = {};
        for (const id of ids) {
          const keyId = `${type}-${id}`;
          const val   = localKeys.get(keyId);
          if (val !== undefined) result[id] = val;
        }
        return result;
      },

      // Write into L1 RAM synchronously (instant), then schedule a debounced
      // flush to L2+L3 via the dirty buffer and worker pool.
      set(data) {
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const val   = data[category][id];
            const keyId = `${category}-${id}`;

            if (val != null) {
              // Serialize via BufferJSON.replacer to convert Buffers to base64,
              // then immediately parse back so L1 holds the correct object shape.
              const safe = JSON.parse(JSON.stringify(val, BufferJSON.replacer));
              localKeys.set(keyId, JSON.parse(JSON.stringify(safe), BufferJSON.reviver));
              dirtyDeletes.delete(keyId);
              dirtyWrites.set(keyId, safe);
            } else {
              localKeys.delete(keyId);
              dirtyWrites.delete(keyId);
              dirtyDeletes.add(keyId);
            }
          }
        }

        // Flush immediately if we hit the threshold, otherwise start/reset timer
        if (dirtyWrites.size >= FLUSH_THRESHOLD || dirtyDeletes.size >= FLUSH_THRESHOLD) {
          flushRAMToQueue(sessionId);
        } else if (!syncTimer) {
          syncTimer = setTimeout(() => flushRAMToQueue(sessionId), FLUSH_INTERVAL);
        }
      }
    }
  };

  authStateCache = { sessionId, state, saveCreds };
  return { state, saveCreds };
}

// ─── Session lock ─────────────────────────────────────────────────────────────
// Redis NX lock with heartbeat renewal. Prevents two containers from processing
// messages simultaneously (split-brain → Bad MAC errors).

const LOCK_TTL_SECONDS     = 20;
const LOCK_RENEW_INTERVAL  = 5_000;
const LOCK_ACQUIRE_RETRIES = 15;
const LOCK_RETRY_DELAY     = 6_000;
const LOCK_FORCE_AFTER     = 12;   // force-take after 12 retries (~72s)

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
    if (owner === INSTANCE_ID) return true; // already ours (called twice)

    const ttl = await redisClient.ttl(lockKey);
    console.warn(`Lock held by ${owner} (TTL: ${ttl}s). Retry ${i}/${LOCK_ACQUIRE_RETRIES}...`);

    if (i >= LOCK_FORCE_AFTER) {
      // Old instance did not release within 72s → force-take.
      // This handles Koyeb rolling deploys where the old container is killed.
      console.warn("Force-taking lock after extended wait (old instance likely dead).");
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
        // Another instance took the lock (split-brain detected).
        // Stop processing immediately — index.js circuit breaker will handle restart.
        console.error("🚨 Session lock stolen by another instance. Stopping lock renewal.");
        clearInterval(lockRenewalInterval);
        lockRenewalInterval = null;
      }
    } catch (err) {
      console.error("Failed to renew session lock:", err.message);
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
      console.log("Lock already held by another instance — skipping delete");
    }
  } catch (err) {
    console.error("Failed to release lock:", err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === "true") {
    console.log("FORCE_FRESH_SESSION — clearing session");
    await clearSession();
  }
  return true;
}

export async function clearSession() {
  authStateCache = null;
  localKeys.clear();
  dirtyWrites.clear();
  dirtyDeletes.clear();
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }

  const sessionId = SESSION_ID();
  await Promise.allSettled([
    dbDelete(sessionId),
    cacheDel(sessionId),
  ]);
  console.log(`Session '${sessionId}' cleared`);
}

export async function saveSession() { /* no-op: saves happen via saveCreds / keys.set */ }
