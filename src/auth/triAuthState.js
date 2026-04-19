/**
 * triAuthState.js — Tri-Layer Baileys AuthenticationState
 *
 * Read path:  L1 RAM (sub-ms) → L2 Redis (1-5ms) → L3 Supabase (10-50ms)
 * Write path: L1 RAM sync → L2 Redis async → L3 Supabase debounced batch
 *
 * Fixes applied vs original:
 *   1. proto imported — app-state-sync-key values reconstructed as protobuf
 *   2. deleteKey race resolved — DELETE waits for any in-flight flush
 *   3. flushPendingWrites uses promise resolvers, not setInterval polling
 *   4. In-flight request coalescing for L3 reads — prevents N→1 DB hammering
 *   5. keys.set serializes writes sequentially per-type to cap flush bursts
 */

import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { ramCache }                          from './lruCache.js';
import { redis, REDIS_KEY_PREFIX, REDIS_TTL_SECONDS } from './redisClient.js';
import { supabase }                          from './supabaseClient.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Composite cache / DB key */
const buildKey = (sessionId, type, id) => `${sessionId}:${type}:${id}`;

/** Serialize to JSON using Baileys' Buffer-safe replacer */
const serialize = (data) => JSON.stringify(data, BufferJSON.replacer);

/**
 * Deserialize from JSON, then reconstruct protobuf where required.
 *
 * FIX 1 (Critical): app-state-sync-key values are stored as plain JSON but
 * Baileys' internal decryption code calls `.toObject()` and `.serializeBinary()`
 * on them — methods that only exist on protobuf instances. Without this
 * reconstruction step the bot crashes with:
 *   TypeError: value.toObject is not a function
 * at the first encrypted app-state sync after a restart.
 */
const deserialize = (raw, type) => {
  const value = JSON.parse(raw, BufferJSON.reviver);
  if (type === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
};

// ─── In-flight request coalescing ────────────────────────────────────────────
/**
 * FIX 9 (Low): During a message burst, the same Signal key may be requested
 * dozens of times concurrently. Without coalescing, each request that misses
 * L1 and L2 fires an independent Supabase query for the same row.
 *
 * inflightL3 maps a cacheKey → Promise<string|null> for any L3 read currently
 * in progress. Subsequent requests for the same key attach to the existing
 * promise rather than launching a new DB read. The entry is deleted once the
 * read settles so the next miss goes to DB fresh.
 */
const inflightL3 = new Map();

// ─── Read: L1 → L2 → L3 ──────────────────────────────────────────────────────

async function readRaw(sessionId, type, id) {
  const cacheKey = buildKey(sessionId, type, id);

  // L1: RAM — sub-millisecond
  const l1 = ramCache.get(cacheKey);
  if (l1 !== undefined) return l1;

  // L2: Redis — 1–5ms
  let l2Raw = null;
  try {
    l2Raw = await redis.get(`${REDIS_KEY_PREFIX}${cacheKey}`);
  } catch (e) {
    console.warn('[Redis] Read failed, falling back to Supabase:', e.message);
  }

  if (l2Raw !== null) {
    ramCache.set(cacheKey, l2Raw); // backfill L1
    return l2Raw;
  }

  // L3: Supabase — coalesced so concurrent misses share one DB round-trip
  if (inflightL3.has(cacheKey)) {
    return inflightL3.get(cacheKey); // attach to in-progress request
  }

  const l3Promise = supabase
    .from('baileys_auth_keys')
    .select('value')
    .eq('session_id', sessionId)
    .eq('key_type', type)
    .eq('key_id', id)
    .maybeSingle()
    .then(async ({ data, error }) => {
      if (error) {
        console.error('[Supabase] Read error:', error.message);
        return null;
      }

      const raw = data?.value ?? null;

      if (raw !== null) {
        // Backfill L2 and L1 so future reads are served from cache
        try {
          await redis.setex(`${REDIS_KEY_PREFIX}${cacheKey}`, REDIS_TTL_SECONDS, raw);
        } catch (e) {
          console.warn('[Redis] Backfill write failed:', e.message);
        }
        ramCache.set(cacheKey, raw);
      }

      return raw;
    })
    .finally(() => {
      inflightL3.delete(cacheKey); // release coalescing slot
    });

  inflightL3.set(cacheKey, l3Promise);
  return l3Promise;
}

async function readKey(sessionId, type, id) {
  const raw = await readRaw(sessionId, type, id);
  if (raw === null) return null;
  return deserialize(raw, type);
}

// ─── Write: L1 sync → L2 async → L3 debounced/chunked batch ──────────────────

const pendingUpserts = new Map();

let flushTimer    = null;
let isFlushing    = false;

/**
 * FIX 3 (High): Replace setInterval polling with Promise resolvers.
 *
 * The original flushPendingWrites polled `if (!isFlushing)` every 50ms,
 * burning CPU and adding up to 50ms of unnecessary latency before the
 * final SIGTERM flush could proceed.
 *
 * flushResolvers holds resolve() callbacks registered by callers that need
 * to wait for the current flush to complete. flushNow's finally block drains
 * the array, unblocking all waiters instantly when the flush settles.
 */
const flushResolvers = [];

function waitForCurrentFlush() {
  if (!isFlushing) return Promise.resolve();
  return new Promise((resolve) => flushResolvers.push(resolve));
}

function drainFlushResolvers() {
  while (flushResolvers.length > 0) {
    flushResolvers.shift()();
  }
}

async function flushNow() {
  if (isFlushing) {
    scheduleFlush();
    return;
  }

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (pendingUpserts.size === 0) return;

  isFlushing = true;
  const batch = [...pendingUpserts.values()];
  pendingUpserts.clear();

  try {
    const { error } = await supabase
      .from('baileys_auth_keys')
      .upsert(batch, { onConflict: 'session_id,key_type,key_id' });

    if (error) {
      console.error('[Supabase] Batch upsert error:', error.message);
      // Re-queue failed rows (last-write-wins semantics)
      batch.forEach((row) => {
        const k = buildKey(row.session_id, row.key_type, row.key_id);
        if (!pendingUpserts.has(k)) pendingUpserts.set(k, row);
      });
      scheduleFlush();
    }
  } finally {
    isFlushing = false;
    drainFlushResolvers(); // FIX 3: unblock any waiters immediately
    if (pendingUpserts.size > 0) scheduleFlush();
  }
}

function scheduleFlush() {
  if (flushTimer) return; // already scheduled
  flushTimer = setTimeout(flushNow, 500);
}

const MAX_BATCH_SIZE = 200;

async function writeKey(sessionId, type, id, value) {
  const cacheKey = buildKey(sessionId, type, id);
  const raw      = serialize(value);

  // L1: RAM — synchronous, zero latency
  ramCache.set(cacheKey, raw);

  // L2: Redis — fire-and-forget, non-blocking
  redis
    .setex(`${REDIS_KEY_PREFIX}${cacheKey}`, REDIS_TTL_SECONDS, raw)
    .catch((e) => console.warn('[Redis] Write failed:', e.message));

  // L3: Supabase — enqueue for batch upsert
  pendingUpserts.set(cacheKey, {
    session_id: sessionId,
    key_type:   type,
    key_id:     id,
    value:      raw,
    updated_at: new Date().toISOString(),
  });

  if (pendingUpserts.size >= MAX_BATCH_SIZE) {
    await flushNow();
  } else {
    scheduleFlush();
  }
}

/**
 * FIX 2 (Critical): deleteKey data-resurrection race.
 *
 * Original code called `pendingUpserts.delete(cacheKey)` then immediately
 * issued a Supabase DELETE. But if `isFlushing === true`, `flushNow()` had
 * already copied the pending map into `batch` and was mid-upsert. The upsert
 * would complete AFTER the DELETE, re-inserting the deleted row.
 *
 * Fix: wait for any in-flight flush to settle (via the promise resolver
 * mechanism) before issuing the Supabase DELETE. This guarantees the
 * DELETE always executes last.
 */
async function deleteKey(sessionId, type, id) {
  const cacheKey = buildKey(sessionId, type, id);

  // L1: RAM — immediate
  ramCache.delete(cacheKey);

  // Remove from pending batch before waiting — prevents re-queue after flush
  pendingUpserts.delete(cacheKey);

  // L2: Redis — fire-and-forget
  redis
    .del(`${REDIS_KEY_PREFIX}${cacheKey}`)
    .catch((e) => console.warn('[Redis] Delete failed:', e.message));

  // Wait for any in-flight Supabase upsert to complete.
  // The in-flight batch may contain this key — we must delete AFTER it lands.
  await waitForCurrentFlush();

  // L3: Supabase — now safe to delete, no in-flight upsert can resurrect it
  const { error } = await supabase
    .from('baileys_auth_keys')
    .delete()
    .eq('session_id', sessionId)
    .eq('key_type', type)
    .eq('key_id', id);

  if (error) {
    console.error('[Supabase] Delete error:', error.message);
  }
}

// ─── Credentials ──────────────────────────────────────────────────────────────

const CREDS_TYPE = '__creds__';
const CREDS_ID   = 'creds';

async function readCreds(sessionId) {
  const existing = await readKey(sessionId, CREDS_TYPE, CREDS_ID);
  return existing ?? initAuthCreds();
}

async function writeCreds(sessionId, creds) {
  await writeKey(sessionId, CREDS_TYPE, CREDS_ID, creds);
}

// ─── Clear entire session from all tiers ─────────────────────────────────────

export async function clearTriSession(sessionId) {
  // L1: clear all RAM entries for this session
  for (const key of ramCache.keys()) {
    if (key.startsWith(`${sessionId}:`)) ramCache.delete(key);
  }

  // L2: clear Redis (scan for matching keys)
  try {
    const pattern  = `${REDIS_KEY_PREFIX}${sessionId}:*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (e) {
    console.warn('[Redis] Session clear failed:', e.message);
  }

  // L3: Supabase — delete all rows for this session
  const { error } = await supabase
    .from('baileys_auth_keys')
    .delete()
    .eq('session_id', sessionId);

  if (error) throw new Error(`[Supabase] Session clear failed: ${error.message}`);

  console.log(`[Auth] Session '${sessionId}' cleared from all tiers`);
}

// ─── Main Factory ─────────────────────────────────────────────────────────────

export async function useTriAuthState(sessionId) {
  const creds = await readCreds(sessionId);

  const state = {
    creds,

    keys: {
      /**
       * Parallel reads are safe — each request is independent.
       * L3 coalescing ensures concurrent misses for the same key
       * share one DB round-trip rather than firing N queries.
       */
      get: async (type, ids) => {
        const result = {};
        await Promise.all(
          ids.map(async (id) => {
            const val = await readKey(sessionId, type, id);
            if (val !== null && val !== undefined) result[id] = val;
          })
        );
        return result;
      },

      /**
       * FIX 10 (Low): Process type-groups sequentially to prevent N concurrent
       * flushNow() calls from all hitting MAX_BATCH_SIZE simultaneously.
       * Within each type group, individual key writes are still parallel.
       */
      set: async (data) => {
        for (const [type, ids] of Object.entries(data)) {
          await Promise.all(
            Object.entries(ids ?? {}).map(([id, value]) =>
              value !== null && value !== undefined
                ? writeKey(sessionId, type, id, value)
                : deleteKey(sessionId, type, id)
            )
          );
        }
      },
    },
  };

  const saveCreds = async () => {
    await writeCreds(sessionId, state.creds);
  };

  return { state, saveCreds };
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

/**
 * FIX 3 (High): Replaced setInterval polling with direct promise-resolver await.
 *
 * Call this in SIGTERM / SIGINT handlers before process.exit() to drain
 * the Supabase write buffer. Koyeb sends SIGTERM before container kill,
 * giving a window to flush without data loss on rolling restarts.
 */
export async function flushPendingWrites() {
  // Wait for any in-flight flush using the resolver mechanism (not polling)
  await waitForCurrentFlush();

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (pendingUpserts.size === 0) {
    console.log('[Auth] No pending writes to flush.');
    return;
  }

  console.log(`[Auth] Flushing ${pendingUpserts.size} pending writes to Supabase...`);

  const batch = [...pendingUpserts.values()];
  pendingUpserts.clear();

  const { error } = await supabase
    .from('baileys_auth_keys')
    .upsert(batch, { onConflict: 'session_id,key_type,key_id' });

  if (error) {
    console.error('[Auth] Final flush error:', error.message);
    throw error; // re-throw so the shutdown handler knows flush failed
  }

  console.log('[Auth] Graceful flush complete.');
}
