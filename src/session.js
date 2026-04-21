/**
 * session.js — Session management integration layer
 *
 * Bridges the tri-layer auth system with index.js.
 *
 * BUGS FIXED IN THIS VERSION:
 *
 * BUG 3 (HIGH — DURABILITY GAP):
 *   The previous saveCreds debouncer used a trailing timer that kept being
 *   reset by rapid creds.update events during initial QR link and history sync.
 *   If the trailing timer never fired before a container restart, Supabase
 *   held stale creds, causing session establishment failures on next boot.
 *   FIX: Removed the debounce entirely. saveCreds now calls rawSaveCreds()
 *   directly on every invocation. Creds updates are infrequent (unlike session
 *   key rotations which hit keys.set), so the overhead is negligible. The
 *   writeKey batch mechanism in triAuthState already handles Supabase efficiency.
 *
 * BUG 2-SHUTDOWN (CRITICAL — SUPABASE BUFFER NEVER DRAINED):
 *   The previous shutdown() in index.js used `await new Promise(r => setTimeout(r, 2000))`
 *   as a proxy for flushing — a blind 2s sleep that never called flushPendingWrites().
 *   Under load or network variance, Supabase writes weren't completing in that window,
 *   leaving up to 500ms of key updates unwritten. The drainPendingDbWrites export
 *   here gives index.js the explicit flush function it needs.
 */

import { useTriAuthState, clearTriSession, flushPendingWrites } from './auth/triAuthState.js';
import { redis }    from './auth/redisClient.js';
import { botConfig } from './config.js';

// Re-export redisClient so index.js can quit it on shutdown
export { redis as redisClient };

// ─── Session ID ───────────────────────────────────────────────────────────────
// Throws on missing BOT_NUMBER — prevents silent use of "default" key in prod.

export function SESSION_ID() {
  const id = botConfig.BOT_NUMBER || process.env.BOT_NUMBER;
  if (!id) {
    throw new Error(
      'BOT_NUMBER is not set. Add it as a Koyeb environment variable. ' +
      'Without it, session keys will be stored under the wrong key prefix.'
    );
  }
  return id;
}

// ─── Session lock ─────────────────────────────────────────────────────────────
// Prevents multiple Koyeb instances writing to the same Signal session.
// Uses INSTANCE_ID (not PID — all Koyeb containers run as PID 1).

const LOCK_TTL_SECONDS     = 20;
const LOCK_RENEW_INTERVAL  = 5_000;
const LOCK_ACQUIRE_RETRIES = 15;
const LOCK_RETRY_DELAY     = 6_000;   // 6s × 15 = 90s total window
const LOCK_FORCE_AFTER     = 12;      // force-take after ~72s

const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let lockRenewalInterval = null;

function getLockKey() {
  try { return `${SESSION_ID()}:lock`; }
  catch { return `${process.env.BOT_NUMBER || 'default'}:lock`; }
}

export async function acquireSessionLock() {
  const lockKey = getLockKey();

  for (let i = 1; i <= LOCK_ACQUIRE_RETRIES; i++) {
    const acquired = await redis.set(lockKey, INSTANCE_ID, 'NX', 'EX', LOCK_TTL_SECONDS);

    if (acquired) {
      console.log(`🔒 Session lock acquired (${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    const owner = await redis.get(lockKey);

    if (owner === INSTANCE_ID) {
      console.warn('⚠️  acquireSessionLock called twice — reusing existing lock');
      return true;
    }

    const ttl = await redis.ttl(lockKey);
    console.warn(`⚠️  Lock held by ${owner} (TTL: ${ttl}s). Retry ${i}/${LOCK_ACQUIRE_RETRIES}...`);

    if (i >= LOCK_FORCE_AFTER) {
      console.warn(`⚠️  Force-taking session lock after ${i} retries (old instance should be dead)`);
      await redis.set(lockKey, INSTANCE_ID, 'EX', LOCK_TTL_SECONDS);
      console.log(`🔒 Lock force-acquired (${INSTANCE_ID})`);
      startLockRenewal(lockKey);
      return true;
    }

    await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY));
  }

  console.error('❌ Could not acquire session lock after all retries');
  return false;
}

function startLockRenewal(lockKey) {
  if (lockRenewalInterval) clearInterval(lockRenewalInterval);

  lockRenewalInterval = setInterval(async () => {
    try {
      const current = await redis.get(lockKey);
      if (current === INSTANCE_ID) {
        await redis.expire(lockKey, LOCK_TTL_SECONDS);
      } else {
        console.error('❌ Lock ownership lost — another instance took over');
        clearInterval(lockRenewalInterval);
        lockRenewalInterval = null;
      }
    } catch (err) {
      console.error('❌ Failed to renew session lock:', err.message);
    }
  }, LOCK_RENEW_INTERVAL);
}

export async function releaseSessionLock() {
  if (lockRenewalInterval) {
    clearInterval(lockRenewalInterval);
    lockRenewalInterval = null;
  }

  try {
    const lockKey = getLockKey();
    const current = await redis.get(lockKey);
    if (current === INSTANCE_ID) {
      await redis.del(lockKey);
      console.log('🔓 Session lock released');
    } else {
      console.log('🔓 Lock already held by another instance — skipping delete');
    }
  } catch (err) {
    console.error('❌ Failed to release session lock:', err.message);
  }
}

// ─── Auth state ───────────────────────────────────────────────────────────────

export async function getAuthState() {
  try {
    await redis.ping();
  } catch (err) {
    // Non-fatal: Redis is L2. triAuthState degrades gracefully to L3.
    console.warn('⚠️  Redis ping failed — L2 degraded, falling through to Supabase:', err.message);
  }

  const sessionId = SESSION_ID();
  const { state, saveCreds: rawSaveCreds } = await useTriAuthState(sessionId);

  // Integrity check: a partial Supabase read produces an incomplete state.
  // Baileys connects but immediately fails with cryptographic errors.
  if (state.creds && (!state.creds.noiseKey || !state.creds.signedIdentityKey)) {
    throw new Error(
      `Auth state for '${sessionId}' is incomplete — noiseKey or signedIdentityKey missing. ` +
      'Set FORCE_FRESH_SESSION=true to force a fresh QR scan.'
    );
  }

  if (!state.creds.noiseKey) {
    console.log(`ℹ️  No session found for '${sessionId}' — QR login required`);
  }

  /**
   * BUG 3 FIX: No debounce on saveCreds.
   *
   * The previous leading/trailing debounce introduced a 1.5s window where
   * creds updates weren't persisted. During initial auth when Baileys fires
   * creds.update rapidly, the trailing timer kept getting reset, meaning
   * the latest creds were never written to Supabase before a container restart.
   *
   * Creds updates happen infrequently in steady state (not per-message like
   * session key rotations). The writeKey → batch flush mechanism in
   * triAuthState.js already handles Supabase write efficiency. We don't
   * need an additional debounce layer here.
   *
   * Each creds.update now writes directly through, ensuring durability.
   */
  const saveCreds = async () => {
    try {
      await rawSaveCreds();
    } catch (err) {
      console.error('🚨 CRITICAL: saveCreds failed — Signal keys may desync:', err.message);
      // Re-throw so Baileys' internal error handling can react
      throw err;
    }
  };

  return { state, saveCreds };
}

// ─── Clear session ────────────────────────────────────────────────────────────

export async function clearSession() {
  const sessionId = SESSION_ID();
  await clearTriSession(sessionId);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { flushPendingWrites };

// Alias used by index.js shutdown handler
export { flushPendingWrites as drainPendingDbWrites };

// ─── Legacy stubs (index.js compatibility) ───────────────────────────────────

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === 'true') {
    console.log('🆕 FORCE_FRESH_SESSION — clearing all tiers');
    try {
      await clearSession();
    } catch (err) {
      console.error('clearSession failed during FORCE_FRESH_SESSION:', err.message);
    }
  }
  return true;
}

export async function saveSession() {
  // No-op: triAuthState handles persistence automatically via writeKey + flushNow
}
