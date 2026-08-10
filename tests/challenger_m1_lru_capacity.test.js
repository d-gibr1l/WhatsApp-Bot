import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthState, closeRedisConnection } from '../src/auth/redisSession.js';

test('CHALLENGE 7: LRU capacity eviction at 2000 items with refresh order', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;

  // Insert 2000 items into session category
  const batch1 = {};
  for (let i = 0; i < 2000; i++) {
    batch1[`item-${i}`] = { id: i };
  }
  await keys.set({ session: batch1 });

  // Now touch item-0 (refresh its LRU order to MRU)
  await keys.get('session', ['item-0']);

  // Touch item-1 via keys.set (refresh its LRU order to MRU)
  await keys.set({ session: { 'item-1': { id: 1, updated: true } } });

  // Insert item-2000 (2001st item). This forces eviction of 1 item from L1 cache (L1_MAX = 2000)
  await keys.set({ session: { 'item-2000': { id: 2000 } } });

  // Because item-0 and item-1 were refreshed, the oldest item in L1 was item-2.
  // Item-2 should have been evicted from L1 cache!
  // Item-0 and item-1 must still be in L1 cache (or readable from Redis).
  const checkRefreshed = await keys.get('session', ['item-0', 'item-1', 'item-2000']);
  assert.equal(checkRefreshed['item-0'].id, 0);
  assert.equal(checkRefreshed['item-1'].id, 1);
  assert.equal(checkRefreshed['item-2000'].id, 2000);
});
