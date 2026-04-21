import { LRUCache } from 'lru-cache';

/**
 * L1 Cache — In-process RAM store.
 *
 * FIX (Bug 4): Increased `max` from 500 → 2000.
 *
 * A busy Baileys deployment generates:
 *   - 1 `session-*` key per active conversation
 *   - 1 `sender-key-*` key per group member per group
 *   - ~100 `pre-key-*` keys (Baileys maintains a 100-key pool)
 *   - Multiple `app-state-sync-key-*` keys
 *
 * With 5 active groups of 50 members = 250+ sender keys alone.
 * Add sessions, pre-keys, and app-state keys and 500 entries is
 * trivially exceeded during history sync.
 *
 * When LRU evicts an active session key, the next read for that key
 * must go to L2 Redis or L3 Supabase — reopening the backfill race
 * window (Bug 1) on every eviction. More entries in RAM = fewer
 * evictions = fewer L3 reads = fewer Bad MAC opportunities.
 *
 * Memory math: at ~1KB average per serialized key, 2000 entries ≈ 2MB.
 * The 30MB maxSize hard cap is the real governor on Koyeb Nano.
 *
 * allowStale: false — never serve expired entries. Signal key staleness
 * causes Bad MAC; there is no graceful degradation for a wrong ratchet.
 *
 * updateAgeOnGet: true — reading a key resets its eviction timer,
 * keeping hot conversation sessions alive in RAM during active chats.
 */
export const ramCache = new LRUCache({
  max: 2000,
  maxSize: 30 * 1024 * 1024, // 30 MB hard cap
  sizeCalculation: (value) => Buffer.byteLength(value, 'utf8'),
  ttl: 1000 * 60 * 60 * 24 * 7, // 7 days — mirrors Redis TTL
  allowStale: false,
  updateAgeOnGet: true,
});
