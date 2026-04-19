import Redis from 'ioredis';

/**
 * L2 Cache — External Redis / Valkey store.
 *
 * Acts as the durability bridge: if the Koyeb container restarts
 * and L1 RAM is wiped, Redis restores hot keys in milliseconds
 * without a cold read from Supabase.
 *
 * All Redis errors are caught and logged — never thrown. Redis is
 * L2, not the critical path. The system degrades gracefully to L3
 * (Supabase) if Redis is temporarily unreachable.
 *
 * lazyConnect: true — connection is deferred until the first command.
 * Call redis.connect() explicitly at startup to surface errors early,
 * but treat connection failure as non-fatal (catch and continue).
 */
export const redis = new Redis(process.env.REDIS_URL || process.env.VALKEY_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: true,
  connectTimeout: 10_000,
  retryStrategy: (times) => {
    // Exponential backoff capped at 10s — give up after 10 attempts
    if (times > 10) return null; // stop retrying
    return Math.min(times * 200, 10_000);
  },
});

redis.on('error',       (err) => console.error('[Redis] Error (non-fatal):', err.message));
redis.on('reconnecting', ()   => console.warn('[Redis] Reconnecting...'));
redis.on('ready',        ()   => console.log('[Redis] Connected and ready'));

export const REDIS_KEY_PREFIX   = 'baileys:auth:';
export const REDIS_TTL_SECONDS  = 60 * 60 * 24 * 7; // 7 days
