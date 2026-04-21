/**
 * session.js — Session management integration layer
 *
 * Bridges the tri-layer auth system (triAuthState.js) with the bot's
 * existing index.js interface. All exports match the previous contract
 * so index.js requires zero changes.
 *
 * Architecture:
 *   L1 RAM (lruCache)  → L2 Redis/Valkey (redisClient) → L3 Supabase (supabaseClient)
 *
 * Session lock uses Redis NX + TTL with a unique INSTANCE_ID to prevent
 * multiple Koyeb instances writing to the same Signal session simultaneously,
 * which causes connectionReplaced (440) loops and key corruption.
 */

import { useTriAuthState, clearTriSession, flushPendingWrites } from './auth/triAuthState.js';
import { redis }    from './auth/redisClient.js';
import { botConfig } from './config.js';

// Re-export redisClient so index.js can call redis.quit() on shutdown
export { redis as redisClient };

// ─── Session ID ───────────────────────────────────────────────────────────────

export function SESSION_ID() {
  const id = botConfig.BOT_NUMBER || process.env.BOT_NUMBER;
  if (!id) {
    throw new Error(
      'BOT_NUMBER is not set. Add it as a Koyeb environment variable. ' +
      'Without it, session keys will be stored under the wrong Redis hash.'
    );
  }
  return id;
}

// ─── Session lock ─────────────────────────────────────────────────────────────

const LOCK_TTL_SECONDS    = 20;
const LOCK_RENEW_INTERVAL = 5_000;
const LOCK_ACQUIRE_RETRIES = 15;
const LOCK_RETRY_DELAY    = 6_000;
const LOCK_FORCE_AFTER    = 12;

const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let lockRenewalInterval = null;

function getLockKey() {
  try { return `${SESSION_ID()}:lock`; } catch { return `${process.env.BOT_NUMBER || 'default'}:lock`; }
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
      console.warn('⚠️  acquireSessionLock called twice — reusing lock');
      return true;
    }

    const ttl = await redis.ttl(lockKey);
    console.warn(`⚠️  Lock held by ${owner} (TTL: ${ttl}s). Retry ${i}/${LOCK_ACQUIRE_RETRIES}...`);

    if (i >= LOCK_FORCE_AFTER) {
      console.warn(`⚠️  Force-taking session lock after ${i} retries`);
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
      console.error('❌ Failed to renew lock:', err.message);
    }
  }, LOCK_RENEW_INTERVAL);
}

export async function releaseSessionLock() {
  if (lockRenewalInterval) { clearInterval(lockRenewalInterval); lockRenewalInterval = null; }
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
    console.error('❌ Failed to release lock:', err.message);
  }
}

// ─── Auth state ───────────────────────────────────────────────────────────────

export async function getAuthState() {
  try { await redis.ping(); } catch (err) {
    console.warn('⚠️  Redis ping failed — falling through to Supabase:', err.message);
  }

  const sessionId = SESSION_ID();
  const { state, saveCreds: rawSaveCreds } = await useTriAuthState(sessionId);

  // Integrity check: partial reads produce incomplete state that causes Bad MAC
  if (state.creds && (!state.creds.noiseKey || !state.creds.signedIdentityKey)) {
    throw new Error(
      `Auth state for '${sessionId}' is incomplete — noiseKey or signedIdentityKey missing. ` +
      'Set FORCE_FRESH_SESSION=true to force a fresh QR login.'
    );
  }

  if (!state.creds.noiseKey) {
    console.log(`ℹ️  No session found for '${sessionId}' — QR login required`);
  }

  // Debounced saveCreds: leading + trailing execution
  let saveTimer   = null;
  let pendingSave = false;

  const saveCreds = async () => {
    if (!saveTimer) {
      try { await rawSaveCreds(); } catch (err) {
        console.error('🚨 CRITICAL: saveCreds failed (leading):', err.message);
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
          console.error('🚨 CRITICAL: saveCreds failed (trailing):', err.message);
        }
      }
    }, 1500);
  };

  return { state, saveCreds };
}

// ─── Clear session ────────────────────────────────────────────────────────────

export async function clearSession() {
  const sessionId = SESSION_ID();
  await clearTriSession(sessionId);
}

// ─── Graceful drain ───────────────────────────────────────────────────────────

export { flushPendingWrites };

// ─── Legacy stubs ─────────────────────────────────────────────────────────────

export async function loadSession() {
  if (process.env.FORCE_FRESH_SESSION === 'true') {
    console.log('🆕 FORCE_FRESH_SESSION — clearing all tiers');
    try { await clearSession(); } catch (err) {
      console.error('clearSession failed during FORCE_FRESH_SESSION:', err.message);
    }
  }
  return true;
}

export async function saveSession() { /* no-op: triAuthState handles persistence */ }

// Alias for index.js compatibility
export { flushPendingWrites as drainPendingDbWrites };
