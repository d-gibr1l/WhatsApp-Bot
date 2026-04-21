/**
 * triAuthState.js — Tri-Layer Baileys AuthenticationState
 *
 * Read path:  L1 RAM (sub-ms) → L2 Redis (1-5ms) → L3 Supabase (10-50ms)
 * Write path: L1 RAM sync → L2 Redis awaited → L3 Supabase debounced batch
 *
 * BUGS FIXED IN THIS VERSION:
 *
 * BUG 1 (CRITICAL — PRIMARY BAD MAC CAUSE):
 *   L3 backfill unconditionally overwrote L1 RAM with stale Supabase data.
 *   If writeKey() updated L1 during a 10-50ms Supabase round-trip, the
 *   backfill callback would overwrite the fresh ratchet state with the old
 *   DB value. The next decrypt would use the wrong Signal counter → Bad MAC.
 *   FIX: Check ramCache.has(cacheKey) before backfilling. If L1 has data,
 *   a write happened during the query — skip the backfill entirely.
 *
 * BUG 2 (CRITICAL — SAME RACE, L2):
 *   The L3 backfill also unconditionally wrote stale data to Redis (L2).
 *   On container restart: L1 cleared, L2 returns stale value, L1 populated
 *   with stale value → Bad MAC on first decrypt attempt.
 *   FIX: Only backfill Redis when L1 was also empty (no write during query).
 *
 * BUG 5 (MEDIUM — SILENT L2 STALENESS):
 *   Redis writes were fire-and-forget. Silent failures left L2 with stale
 *   Signal session keys. On restart: L1 cleared, L2 stale, L3 may not be
 *   flushed yet → stale session loaded → Bad MAC.
 *   FIX: Await Redis writes for all key types. Accept 1-5ms overhead;
 *   correctness of Signal state is non-negotiable.
 */

import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { ramCache }                          from './lruCache.js';
import { redis, REDIS_KEY_PREFIX, REDIS_TTL_SECONDS } from './redisClient.js';
import { supabase }                          from './supabaseClient.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildKey = (sessionId, type, id) => `${sessionId}:${type}:${id}`;

const serialize = (data) => JSON.stringify(data, BufferJSON.replacer);

/**
 * Deserialize from JSON, then reconstruct protobuf where required.
 *
 * app-state-sync-key values must be reconstructed as proto instances.
 * Baileys' decryption code calls .toObject() and .serializeBinary() on them —
 * methods that only exist on protobuf objects, not plain JSON objects.
 */
const deserialize = (raw, type) => {
  const value = JSON.parse(raw, BufferJSON.reviver);
  if (type === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
};

// ─── In-flight L3 request coalescing ─────────────────────────────────────────
/**
 * During a message burst, the same Signal key may be requested concurrently.
 * Without coalescing, each request that misses L1 and L2 fires an independent
 * Supabase query for the same row.
 *
 * inflightL3 maps cacheKey → Promise<string|null> for any L3 read in progress.
 * Subsequent requests for the same key attach to the existing promise.
 * The entry is deleted in .finally() so the next cache miss goes to DB fresh.
 *
 * NOTE: Coalescing does NOT prevent the backfill race (Bug 1). Multiple callers
 * sharing one promise all get the same stale DB value. The backfill guard
 * (ramCache.has check) is what prevents the overwrite.
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
    // Backfill L1 from Redis only if L1 is still empty.
    // A writeKey() could have populated L1 between the Redis call and now.
    if (!ramCache.has(cacheKey)) {
      ramCache.set(cacheKey, l2Raw);
    }
    return l2Raw;
  }

  // L3: Supabase — coalesced so concurrent misses share one DB round-trip
  if (inflightL3.has(cacheKey)) {
    return inflightL3.get(cacheKey);
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
        /**
         * BUG 1 + BUG 2 FIX (CRITICAL):
         *
         * This .then() callback runs 10-50ms after the query was initiated.
         * During that window, writeKey() may have been called for this same key
         * (e.g., Baileys advanced the Signal ratchet due to an incoming message)
         * and updated L1 RAM with a NEWER state.
         *
         * Before this fix: ramCache.set(cacheKey, raw) ran unconditionally,
         * overwriting the fresh ratchet state with the stale DB value.
         * The next decrypt attempt used the wrong counter → Bad MAC.
         *
         * Fix: Check ramCache.has() before backfilling.
         *   - If L1 has data: a writeKey() ran during our query. The in-memory
         *     value is newer than what Supabase returned. Skip backfill.
         *   - If L1 is empty: no write happened. Safe to backfill both L2 + L1.
         *
         * We use the SAME guard for L2 Redis: only backfill Redis when L1 was
         * also empty, ensuring L2 doesn't get poisoned with stale data either.
         */
        if (!ramCache.has(cacheKey)) {
          // L1 is still empty — no write happened during the Supabase round-trip.
          // Safe to backfill both tiers.
          try {
            await redis.setex(`${REDIS_KEY_PREFIX}${cacheKey}`, REDIS_TTL_SECONDS, raw);
          } catch (e) {
            console.warn('[Redis] L3→L2 backfill failed:', e.message);
          }
          ramCache.set(cacheKey, raw);
        }
        // If L1 has data: discard the stale DB value. The in-memory ratchet
        // state is authoritative. Do NOT write to L2 either.
      }

      return raw;
    })
    .finally(() => {
      inflightL3.delete(cacheKey);
    });

  inflightL3.set(cacheKey, l3Promise);
  return l3Promise;
}

async function readKey(sessionId, type, id) {
  const raw = await readRaw(sessionId, type, id);
  if (raw === null || raw === undefined) return null;
  return deserialize(raw, type);
}

// ─── Write: L1 sync → L2 awaited → L3 debounced/chunked batch ────────────────

const pendingUpserts = new Map();
let flushTimer    = null;
let isFlushing    = false;

/**
 * Promise-resolver mechanism for waitForCurrentFlush().
 *
 * Callers that need to wait for an in-flight flush register a resolve()
 * here. flushNow's finally block drains the array, unblocking all waiters
 * instantly when the flush settles — no polling, no wasted CPU.
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
      // Re-queue failed rows — only if a newer value hasn't arrived in the meantime.
      // last-write-wins: if pendingUpserts already has a newer version of a key,
      // don't overwrite it with the failed older row.
      batch.forEach((row) => {
        const k = buildKey(row.session_id, row.key_type, row.key_id);
        if (!pendingUpserts.has(k)) pendingUpserts.set(k, row);
      });
      scheduleFlush();
    }
  } finally {
    isFlushing = false;
    drainFlushResolvers();
    if (pendingUpserts.size > 0) scheduleFlush();
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, 500);
}

const MAX_BATCH_SIZE = 200;

async function writeKey(sessionId, type, id, value) {
  const cacheKey = buildKey(sessionId, type, id);
  const raw      = serialize(value);

  // L1: RAM — synchronous, zero latency.
  // Must happen before any await so L1 is always the most current tier.
  ramCache.set(cacheKey, raw);

  /**
   * BUG 5 FIX (MEDIUM): Await Redis writes instead of fire-and-forget.
   *
   * Fire-and-forget meant: if the Redis connection dropped mid-write
   * and ioredis exhausted retries, the write was silently discarded.
   * L1 had the new value but L2 had the old one. On container restart:
   * L1 cleared, L2 returned stale value → stale state loaded → Bad MAC.
   *
   * Awaiting adds 1-5ms per write. This is acceptable — Signal ratchet
   * correctness is not negotiable. The ~2ms Redis RTT is far cheaper
   * than diagnosing and recovering from Bad MAC errors.
   *
   * Errors are caught and logged but don't throw — L1 is the ground
   * truth and L3 Supabase is the durability layer. A failed L2 write
   * degrades to L3 on restart, which is still correct.
   */
  try {
    await redis.setex(`${REDIS_KEY_PREFIX}${cacheKey}`, REDIS_TTL_SECONDS, raw);
  } catch (e) {
    console.warn(`[Redis] Write failed for ${cacheKey} — L2 degraded, L3 will recover on restart:`, e.message);
  }

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

async function deleteKey(sessionId, type, id) {
  const cacheKey = buildKey(sessionId, type, id);

  // L1: RAM — immediate
  ramCache.delete(cacheKey);

  // Remove from pending batch BEFORE waiting for flush.
  // Prevents a queued upsert from re-inserting this key after the DELETE.
  pendingUpserts.delete(cacheKey);

  // L2: Redis
  try {
    await redis.del(`${REDIS_KEY_PREFIX}${cacheKey}`);
  } catch (e) {
    console.warn(`[Redis] Delete failed for ${cacheKey}:`, e.message);
  }

  // Wait for any in-flight Supabase upsert to settle before issuing the DELETE.
  // If isFlushing is true, the in-flight batch may contain this key in its
  // snapshot. We must let that upsert complete first, then DELETE wins.
  await waitForCurrentFlush();

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
  // Wait for any in-flight flush before wiping — prevents resurrection
  await waitForCurrentFlush();

  // Clear pending batch for this session
  for (const key of pendingUpserts.keys()) {
    if (key.startsWith(`${sessionId}:`)) pendingUpserts.delete(key);
  }

  // L1: RAM
  for (const key of ramCache.keys()) {
    if (key.startsWith(`${sessionId}:`)) ramCache.delete(key);
  }

  // L2: Redis — scan and delete all matching keys
  try {
    const pattern = `${REDIS_KEY_PREFIX}${sessionId}:*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (e) {
    console.warn('[Redis] Session clear failed (L2):', e.message);
  }

  // L3: Supabase
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
       * Parallel reads per type-group are safe — each ID is independent.
       * The inflightL3 coalescing map prevents N→1 Supabase queries for
       * the same key when many messages arrive simultaneously.
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
       * Type groups are processed sequentially (for...of + await).
       * Within each type group, writes for different key IDs are parallel.
       *
       * Sequential type groups prevent N concurrent flushNow() calls from
       * all hitting MAX_BATCH_SIZE simultaneously and launching overlapping
       * Supabase upserts.
       *
       * Within-group parallel writes are safe: ioredis's single connection
       * sends commands in FIFO order, so Redis always applies them correctly
       * even for the same key ID across rapid consecutive keys.set calls.
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
 * Drain all pending Supabase writes before process exit.
 *
 * Call this in SIGTERM/SIGINT handlers BEFORE redis.quit() and process.exit().
 * Koyeb sends SIGTERM and gives ~10s before SIGKILL — enough time to drain
 * a batch, but only if we actually call this function.
 *
 * The original index.js shutdown() used a blind 2s sleep and never called
 * flushPendingWrites. That's fixed in session.js / index.js.
 */
export async function flushPendingWrites() {
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
    throw error;
  }

  console.log('[Auth] Graceful flush complete.');
}
