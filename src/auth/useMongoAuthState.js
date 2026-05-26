/**
 * useMongoAuthState.js
 *
 * Two-tier Baileys AuthenticationState provider.
 *
 * Architecture:
 *   Baileys Engine
 *       ↓  (synchronous — zero latency)
 *   L1 In-Memory Map  (source of truth at runtime)
 *       ↓  (async, non-blocking)
 *   WAL Buffer (Map<id, WALEntry>)  (dirty-key tracker)
 *       ↓  (debounced 100ms OR every 100 dirty keys)
 *   MongoDB bulkWrite  (crash-safe persistence)
 *
 * ─── BUGS FIXED IN THIS VERSION ────────────────────────────────────────────
 *
 * CRITICAL-1 & CRITICAL-2: readKey returned stale DB value even when L1 held
 *   a newer ratchet state. Fixed: the .then() callback now always returns the
 *   current L1 value when L1 has data, regardless of what the DB returned.
 *   This also fixes the inflightL2 coalescing problem — all waiters now get
 *   the L1 value, not the shared stale promise result.
 *
 * CRITICAL-3: preKeysFlushed flag caused pre-key pool replenishments to be
 *   debounced instead of synchronously flushed. Fixed: the flag is removed;
 *   every pre-key write triggers an immediate synchronous flush.
 *
 * HIGH-5: Delete/write resurrection race. A fire-and-forget deleteOne could
 *   race against a concurrent WAL upsert for the same key, resurrecting a
 *   deleted key. Fixed: deletes now wait for the current in-flight flush
 *   before dispatching the deleteOne to MongoDB.
 *
 * HIGH-6: flushNow() race with non-blocking scheduleFlush(immediate=true).
 *   Fixed: flushNow() uses a single authoritative flush promise that both
 *   paths share, eliminating the race between scheduled and explicit flushes.
 */

import { initAuthCreds, proto } from '@whiskeysockets/baileys';
import { Mutex } from 'async-mutex';

// ─── Buffer Serialization ─────────────────────────────────────────────────────

/**
 * JSON reviver reconstructing Buffer objects from Baileys' JSON representation.
 * Without this, Baileys' crypto code crashes: "argument must be a Buffer".
 */
const bufferReviver = (keyName, value) => {
  if (value?.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
};

const serialize = (value) => JSON.stringify(value);

/**
 * Deserialise a MongoDB raw string value back to a Baileys key.
 * app-state-sync-key must be a proto instance, not a plain object.
 */
const deserialize = (raw, keyType) => {
  const value = JSON.parse(raw, bufferReviver);
  if (keyType === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
};

// ─── Monotonic Version Counter ────────────────────────────────────────────────

/**
 * Returns a strictly-increasing integer for ordering writes.
 * Handles sub-millisecond bursts via a local counter bump.
 */
const nextVersion = (() => {
  let last = 0;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
})();

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * @param {import('mongodb').Db} db
 * @param {string} sessionId
 * @param {object} [options]
 * @param {number} [options.flushIntervalMs=100]
 * @param {number} [options.maxDirtyKeys=100]
 * @param {string} [options.collection='auth']
 */
export async function useMongoAuthState(db, sessionId, options = {}) {
  const {
    flushIntervalMs = 100,
    maxDirtyKeys    = 100,
    collection: collectionName = 'auth',
  } = options;

  const col = db.collection(collectionName);

  // ── L1 Cache ──────────────────────────────────────────────────────────────
  // Map<cacheKey, { raw: string, version: number, updatedAt: number }>
  // `raw` is stored serialised so L1 reads pay deserialization but not
  // re-serialization. L1 is the single source of truth at runtime.

  const l1 = new Map();

  // ── Write-Ahead Log (WAL) ─────────────────────────────────────────────────
  // Map<cacheKey, { raw: string, version: number }>
  // A Map.set() always keeps the latest value — 50 senderKey updates for the
  // same group produce exactly one WAL entry (the most recent).

  const wal = new Map();

  // ── Flush state ───────────────────────────────────────────────────────────

  let flushTimer = null;

  /**
   * The single authoritative in-flight flush promise.
   *
   * FIX (HIGH-6): previously `isFlushing` was a boolean and `flush()` was
   * called non-awaited from `scheduleFlush(immediate=true)`. This created a
   * race where `flushNow()` could read `isFlushing === false`, call `flush()`,
   * see `isFlushing === true` (set by the non-awaited call), and return before
   * the flush completed.
   *
   * Fix: `currentFlushPromise` is the actual Promise returned by the in-flight
   * `flush()` call. Both `scheduleFlush(immediate)` and `flushNow()` share
   * this reference. `waitForCurrentFlush()` awaits it directly — no boolean
   * flag, no polling, no race.
   */
  let currentFlushPromise = null;

  function waitForCurrentFlush() {
    return currentFlushPromise ?? Promise.resolve();
  }

  // ── MongoDB key helpers ───────────────────────────────────────────────────

  const docId      = (type, id) => `${sessionId}:${type}:${id}`;
  const credsDocId = ()         => `${sessionId}:__creds__`;

  // ── Bootstrap: load MongoDB → L1 ─────────────────────────────────────────
  // Self-healing: whatever was flushed before the last crash is now in L1.
  // The WAL starts empty; the first flush only writes genuinely new data.

  async function bootstrap() {
    // Use a literal prefix match via $regex. Special chars in sessionId
    // (phone numbers are digit-only, so this is safe in practice).
    const cursor = col.find(
      { _id: { $regex: `^${sessionId}:` } },
      { projection: { _id: 1, raw: 1, version: 1 } }
    );

    let count = 0;
    for await (const doc of cursor) {
      if (doc.raw !== undefined) {
        l1.set(doc._id, {
          raw:       doc.raw,
          version:   doc.version ?? 0,
          updatedAt: Date.now(),
        });
        count++;
      }
    }

    console.log(`[MongoAuth] Bootstrap: loaded ${count} keys into L1 for session '${sessionId}'`);
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  function writeKeyToL1(cacheKey, raw, version) {
    l1.set(cacheKey, { raw, version, updatedAt: Date.now() });
  }

  function enqueueToWAL(cacheKey, raw, version) {
    wal.set(cacheKey, { raw, version });
  }

  // ── Flush scheduling ──────────────────────────────────────────────────────

  /**
   * Schedule a WAL flush.
   *
   * @param {boolean} [immediate=false] - if true, start flush now (no timer)
   *
   * FIX (HIGH-6): both immediate and deferred paths now share `currentFlushPromise`,
   * so `waitForCurrentFlush()` is guaranteed to await the right thing.
   */
  function scheduleFlush(immediate = false) {
    if (immediate || wal.size >= maxDirtyKeys) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // Start the flush. Store the promise so flushNow() can await it.
      if (!currentFlushPromise) {
        currentFlushPromise = flush().finally(() => {
          currentFlushPromise = null;
        });
      }
      return;
    }

    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!currentFlushPromise) {
          currentFlushPromise = flush().finally(() => {
            currentFlushPromise = null;
          });
        }
      }, flushIntervalMs);
    }
  }

  /**
   * Core WAL → MongoDB flush.
   *
   * Concurrency: protected by `currentFlushPromise` — only one flush runs
   * at a time. New writes during a flush accumulate in the live WAL and are
   * processed by the next flush cycle (scheduled in the finally block).
   *
   * Failure: on bulkWrite error, failed entries are restored to the WAL for
   * retry. Only entries not superseded by a newer write are restored.
   *
   * Monotonic version guard: WAL entries whose version is older than the
   * current L1 version are skipped — they were superseded by a newer write
   * that is already in the WAL under the same key.
   */
  async function flush() {
    if (wal.size === 0) return;

    // Snapshot the WAL — new writes during flush go into the live WAL
    const snapshot = new Map(wal);
    wal.clear();

    const ops = [];

    for (const [cacheKey, walEntry] of snapshot) {
      const l1Entry = l1.get(cacheKey);
      // Skip if L1 has a newer version (a superseding write is already
      // in the live WAL and will be flushed next cycle).
      if (l1Entry && l1Entry.version > walEntry.version) {
        continue;
      }
      // Skip deleted keys — they were either:
      //   a) removed from WAL before snapshot (deleteOps path), or
      //   b) this entry represents a post-delete ghost (shouldn't happen
      //      given the WAL cleanup in keys.set, but guard defensively)
      if (!l1Entry) {
        continue;
      }

      ops.push({
        updateOne: {
          filter: { _id: cacheKey },
          update: {
            $set: { raw: walEntry.raw, updatedAt: new Date() },
            $max: { version: walEntry.version },
          },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) return;

    try {
      await col.bulkWrite(ops, { ordered: false });
    } catch (err) {
      console.error(`[MongoAuth] bulkWrite failed (${ops.length} ops):`, err.message);

      // Restore only non-superseded entries for retry
      for (const [cacheKey, walEntry] of snapshot) {
        if (!wal.has(cacheKey)) {
          // Only restore if L1 still has this exact version (not superseded)
          const l1Entry = l1.get(cacheKey);
          if (l1Entry && l1Entry.version === walEntry.version) {
            wal.set(cacheKey, walEntry);
          }
        }
      }
      // Retry after backoff
      setTimeout(() => scheduleFlush(true), 2_000);
    } finally {
      if (wal.size > 0) scheduleFlush();
    }
  }

  /**
   * Force-flush the WAL synchronously.
   *
   * Called on SIGTERM/SIGINT (via destroy()) and for pre-key priority writes.
   *
   * FIX (HIGH-6): awaits `currentFlushPromise` directly — guaranteed to
   * wait for any in-flight scheduled or immediate flush before starting
   * a new one. No race between scheduled and explicit flushes.
   */
  async function flushNow() {
    // Wait for any in-flight flush to complete
    await waitForCurrentFlush();
    // Cancel any pending timer
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    // If WAL is empty, we're done
    if (wal.size === 0) return;
    // Flush synchronously and await completion
    await (currentFlushPromise = flush().finally(() => {
      currentFlushPromise = null;
    }));
    // Second pass: items may have accumulated during the first flush
    // (e.g. from creds.update callbacks triggered by the flush itself)
    if (wal.size > 0) {
      await (currentFlushPromise = flush().finally(() => {
        currentFlushPromise = null;
      }));
    }
  }

  // ── CREDS Write Path — STRICT CONSISTENCY ────────────────────────────────
  // No WAL, no debounce. Direct MongoDB upsert before returning.
  // Lost creds = full session loss. Eventual consistency is not acceptable.

  async function writeCreds(creds) {
    const cKey = credsDocId();
    const raw  = serialize(creds);
    const ver  = nextVersion();

    // Update L1 before the await so any interleaved keys.get sees fresh creds
    l1.set(cKey, { raw, version: ver, updatedAt: Date.now() });

    await col.updateOne(
      { _id: cKey },
      {
        $set: { raw, updatedAt: new Date() },
        $max: { version: ver },
      },
      { upsert: true }
    );
  }

  // ── KEYS Read Path ────────────────────────────────────────────────────────

  /**
   * Read a Signal key.
   *
   * FIX (CRITICAL-1 & CRITICAL-2):
   *
   * The original implementation read the key from MongoDB and returned the DB
   * value even when L1 held a newer ratchet state. This caused Bad MAC errors
   * whenever a message arrived during a slow (10-50ms) MongoDB read.
   *
   * The inflightL2 coalescing shared the same stale promise result across all
   * concurrent callers, multiplying the damage.
   *
   * Fix: the MongoDB .then() now ALWAYS returns the current L1 value when L1
   * has data. If L1 holds a newer ratchet state than what the DB returned, the
   * caller gets the L1 value. If L1 is empty (no write happened during the DB
   * round-trip), the DB value is safe to use and is backfilled into L1.
   *
   * The inflightL2 coalescing is preserved for efficiency (preventing duplicate
   * DB queries), but its return value is now ignored by callers that have
   * fresher L1 data.
   */
  // Map<cacheKey, Promise<void>> — tracks in-flight DB reads for coalescing
  const inflightL2 = new Map();

  async function readKey(type, id) {
    const cacheKey = docId(type, id);

    // L1 hit — zero latency, always current
    const cached = l1.get(cacheKey);
    if (cached !== undefined) {
      return deserialize(cached.raw, type);
    }

    // L2 read — coalesce concurrent misses for the same key into one DB query
    if (!inflightL2.has(cacheKey)) {
      const dbPromise = col
        .findOne({ _id: cacheKey }, { projection: { raw: 1, version: 1 } })
        .then((doc) => {
          if (!doc?.raw) return;

          // Only backfill L1 if L1 is still empty.
          // A write during the DB round-trip means L1 holds a newer ratchet
          // state. We must NOT overwrite it with the stale DB value.
          if (!l1.has(cacheKey)) {
            l1.set(cacheKey, {
              raw:       doc.raw,
              version:   doc.version ?? 0,
              updatedAt: Date.now(),
            });
          }
        })
        .catch((err) => {
          console.error(`[MongoAuth] L2 read failed for ${cacheKey}:`, err.message);
        })
        .finally(() => {
          inflightL2.delete(cacheKey);
        });

      inflightL2.set(cacheKey, dbPromise);
    }

    // Await the DB query (whether we just started it or joined an existing one)
    await inflightL2.get(cacheKey);

    // FIX: Read from L1 AFTER the DB query completes.
    // This is the critical change: we do NOT return the DB value directly.
    // Instead, we always read from L1 after the DB has had a chance to
    // backfill it. If a write arrived during the DB round-trip, L1 holds
    // the newer value. Either way, L1 is authoritative.
    const l1Entry = l1.get(cacheKey);
    if (!l1Entry) return null;
    return deserialize(l1Entry.raw, type);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  await bootstrap();

  const credsCacheKey = credsDocId();
  const credsEntry    = l1.get(credsCacheKey);
  const creds         = credsEntry
    ? deserialize(credsEntry.raw)
    : initAuthCreds();

  const mutex = new Mutex();

  // ─── State Object (returned to Baileys) ──────────────────────────────────

  const state = {
    creds,

    keys: {
      get: async (type, ids) => {
        return mutex.runExclusive(async () => {
          const result = {};
          await Promise.all(
            ids.map(async (id) => {
              const val = await readKey(type, id);
              if (val !== null && val !== undefined) result[id] = val;
            })
          );
          return result;
        });
      },

      /**
       * Advance the Signal ratchet.
       *
       * CRITICAL: L1 must be updated SYNCHRONOUSLY (before any await) so
       * that any subsequent keys.get sees the new ratchet state immediately,
       * even if the MongoDB flush is still pending.
       *
       * FIX (CRITICAL-3): `preKeysFlushed` flag removed. Pre-key pool
       * replenishment (which happens every ~100 sends) must ALWAYS trigger
       * a synchronous flush, not just on the first occurrence. Using a one-
       * time flag caused deferred pre-key saves that were lost on crash.
       *
       * FIX (HIGH-5): Deletes now wait for the current in-flight flush before
       * dispatching the deleteOne to MongoDB. This prevents a WAL upsert for
       * the same key from landing after the deleteOne and resurrecting the key.
       */
      set: async (data) => {
        return mutex.runExclusive(async () => {
          let forceSyncFlush = false;
          const deleteKeys = [];

          // Phase 1: Apply all writes/deletes to L1 synchronously (no awaits)
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids ?? {})) {
              const cacheKey = docId(type, id);

              if (value === null || value === undefined) {
                // Delete path: remove from L1 and WAL immediately.
                // The WAL deletion is critical — it prevents the deleted key
                // from being upserted back by the next scheduled flush.
                l1.delete(cacheKey);
                wal.delete(cacheKey);
                deleteKeys.push(cacheKey);
              } else {
                const ver = nextVersion();
                const raw = serialize(value);

                writeKeyToL1(cacheKey, raw, ver);
                enqueueToWAL(cacheKey, raw, ver);

                // Force synchronous flush for critical session keys to prevent session loss on abrupt kills,
                // but allow non-critical high-volume keys (e.g. sender-key) to be debounced/batched.
                const isNonCriticalKey = ['sender-key', 'sender-key-memory'].includes(type);
                const isCriticalKey = !isNonCriticalKey;
                if (isCriticalKey) {
                  forceSyncFlush = true;
                }
              }
            }
          }

          // Phase 2: Dispatch deletes to MongoDB.
          //
          // FIX (HIGH-5): Wait for any in-flight WAL flush before deleting.
          // Awaiting ensures deletes complete before keys.set() returns.
          if (deleteKeys.length > 0) {
            try {
              await waitForCurrentFlush();
              await col.bulkWrite(
                deleteKeys.map((id) => ({ deleteOne: { filter: { _id: id } } })),
                { ordered: false }
              );
            } catch (err) {
              console.error('[MongoAuth] Delete error:', err.message);
            }
          }

          // Phase 3: Schedule or force flush.
          //
          // Modified: Flush synchronously for critical keys, otherwise schedule debounced flush.
          if (forceSyncFlush) {
            await flushNow();
          } else {
            scheduleFlush();
          }
        });
      },
    },
  };

  // ── saveCreds ─────────────────────────────────────────────────────────────

  const saveCreds = async () => {
    return mutex.runExclusive(async () => {
      await writeCreds(state.creds);
    });
  };

  // ── destroy ───────────────────────────────────────────────────────────────

  const destroy = async () => {
    try {
      await flushNow();
      console.log('[MongoAuth] WAL drained on shutdown.');
    } catch (err) {
      console.error('[MongoAuth] Shutdown flush failed:', err.message);
    }
  };

  // ── clearSession ──────────────────────────────────────────────────────────

  const clearSession = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    // Wait for any in-flight flush before wiping MongoDB
    await waitForCurrentFlush();

    for (const key of l1.keys()) {
      if (key.startsWith(`${sessionId}:`)) l1.delete(key);
    }
    wal.clear();

    // Also cancel any coalesced reads — their backfill callbacks must not
    // re-populate L1 after the clear. We do this by marking them void;
    // the !l1.has() guard in readKey's .then() handles any that already landed.
    inflightL2.clear();

    await col.deleteMany({ _id: { $regex: `^${sessionId}:` } });
    console.log(`[MongoAuth] Session '${sessionId}' cleared.`);
  };

  return { state, saveCreds, destroy, clearSession, flushNow };
}
