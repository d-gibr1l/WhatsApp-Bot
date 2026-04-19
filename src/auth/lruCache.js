import { LRUCache } from 'lru-cache';

/**
 * L1 Cache — In-process RAM store.
 *
 * Tuned for a single WhatsApp session. One account generates
 * roughly 200–800 Signal keys in steady state. 500 entries with a
 * 30MB hard cap comfortably cover this on a Koyeb Nano instance.
 *
 * sizeCalculation measures the serialized JSON string in bytes so
 * the maxSize cap is in real memory units, not entry count alone.
 *
 * allowStale: false ensures we never serve expired entries even if
 * they haven't been evicted yet — Signal key staleness causes Bad MAC.
 */
export const ramCache = new LRUCache({
  max: 500,
  maxSize: 30 * 1024 * 1024, // 30 MB hard cap
  sizeCalculation: (value) => Buffer.byteLength(value, 'utf8'),
  ttl: 1000 * 60 * 60 * 24 * 7, // 7 days — mirrors Redis TTL
  allowStale: false,
  updateAgeOnGet: true, // keep hot keys alive
});
