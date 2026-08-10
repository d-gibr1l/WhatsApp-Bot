import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAuthState,
  purgeCorruptKey,
  purgeAllKeysForJid,
  getRedis,
  closeRedisConnection
} from '../src/auth/redisSession.js';

test('CHALLENGE 1: Synchronous L1 Cache updates during pending Redis writes', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;
  const redis = getRedis();

  const keyId = 'sync-test-key-1';
  const val1 = { registrationId: 101, name: 'initial' };

  // 1. Hook redis.pipeline to delay execution of pipeline.exec()
  const originalPipeline = redis.pipeline.bind(redis);
  let resolveExec;

  redis.pipeline = () => {
    const pipe = originalPipeline();
    const origExec = pipe.exec.bind(pipe);
    pipe.exec = async () => {
      // Wait until we manually resolve
      await new Promise(r => { resolveExec = r; });
      return origExec();
    };
    return pipe;
  };

  try {
    // Initiate keys.set but DO NOT await it yet
    const setPromise = keys.set({
      session: { [keyId]: val1 }
    });

    // Simultaneously, call keys.get IMMEDIATELY before setPromise resolves
    const getResult = await keys.get('session', [keyId]);

    // L1 cache MUST synchronously return val1
    assert.deepEqual(getResult[keyId], val1, 'keys.get should return updated L1 value while Redis pipeline is pending');

    // Now resolve the Redis exec
    if (resolveExec) resolveExec();
    await setPromise;

    // Verify after resolution
    const finalGet = await keys.get('session', [keyId]);
    assert.deepEqual(finalGet[keyId], val1, 'keys.get should still return val1 after pipeline finishes');
  } finally {
    redis.pipeline = originalPipeline;
  }
});

test('CHALLENGE 2: L1 cache eviction/rollback when pending Redis set fails', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;
  const redis = getRedis();

  const keyId = 'fail-write-key-1';
  const valFail = { registrationId: 999 };

  // Mock pipeline ONLY for keys.set
  const originalPipeline = redis.pipeline.bind(redis);
  let shouldFail = true;

  redis.pipeline = () => {
    const pipe = originalPipeline();
    const origExec = pipe.exec.bind(pipe);
    pipe.exec = async () => {
      if (shouldFail) {
        return [[new Error('Simulated Redis write error'), null]];
      }
      return origExec();
    };
    return pipe;
  };

  try {
    // Initiate set which will fail
    const setPromise = keys.set({
      session: { [keyId]: valFail }
    });

    // Synchronously before setPromise rejects, L1 has it
    const getPending = await keys.get('session', [keyId]);
    assert.deepEqual(getPending[keyId], valFail);

    // Now await rejection of setPromise
    await assert.rejects(setPromise, (err) => err.message.includes('Simulated Redis write error'));

    // Turn off failing pipeline so keys.get can query Redis normally
    shouldFail = false;

    // After failure, L1 cache MUST have evicted keyId so stale failed data is NOT retained!
    // Since Redis also doesn't have it, keys.get should return {} (no data for keyId)
    const getAfterFail = await keys.get('session', [keyId]);
    assert.equal(getAfterFail[keyId], undefined, 'Stale uncommitted data must be evicted from L1 on write failure');
  } finally {
    redis.pipeline = originalPipeline;
  }
});

test('CHALLENGE 3: Tombstone in _purgedKeys is immediately cleared on keys.set', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;

  const keyId = 'tombstone-key-1';
  const valNew = { registrationId: 555 };

  // Mark key as corrupt (adds to _purgedKeys tombstone map)
  await purgeCorruptKey('session', keyId);

  // keys.get before set should return empty object (tombstoned)
  const getPurged = await keys.get('session', [keyId]);
  assert.equal(getPurged[keyId], undefined, 'Purged key should not be retrieved');

  // Perform keys.set
  await keys.set({
    session: { [keyId]: valNew }
  });

  // keys.get should IMMEDIATELY retrieve new key (tombstone cleared)
  const getAfterSet = await keys.get('session', [keyId]);
  assert.deepEqual(getAfterSet[keyId], valNew, 'New key should be retrieved after tombstone is cleared');
});

test('CHALLENGE 4: LRU order refresh on keys.set and keys.get', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;

  // Write 3 keys
  await keys.set({
    'pre-key': {
      'lru-1': { num: 1 },
      'lru-2': { num: 2 },
      'lru-3': { num: 3 }
    }
  });

  // Touch lru-1 via keys.get (refreshes LRU order to MRU)
  await keys.get('pre-key', ['lru-1']);

  // Touch lru-2 via keys.set (refreshes LRU order to MRU)
  await keys.set({
    'pre-key': { 'lru-2': { num: 22 } }
  });

  // All 3 keys should be valid
  const res = await keys.get('pre-key', ['lru-1', 'lru-2', 'lru-3']);
  assert.equal(res['lru-1'].num, 1);
  assert.equal(res['lru-2'].num, 22);
  assert.equal(res['lru-3'].num, 3);
});

test('CHALLENGE 5: purgeAllKeysForJid edge cases and wildcard safety', async () => {
  assert.equal(await purgeAllKeysForJid(null), 0);
  assert.equal(await purgeAllKeysForJid(undefined), 0);
  assert.equal(await purgeAllKeysForJid(''), 0);
  assert.equal(await purgeAllKeysForJid('   '), 0);
  assert.equal(await purgeAllKeysForJid(123), 0);
  assert.equal(await purgeAllKeysForJid({}), 0);
  assert.equal(await purgeAllKeysForJid('*'), 0);
});

test('CHALLENGE 6: Concurrent keys.set and keys.get under mixed operations', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;

  const ops = [];
  for (let i = 0; i < 20; i++) {
    ops.push(keys.set({
      'session': { [`concurrent-${i}`]: { id: i } }
    }));
  }
  await Promise.all(ops);

  const ids = Array.from({ length: 20 }, (_, i) => `concurrent-${i}`);
  const results = await keys.get('session', ids);
  for (let i = 0; i < 20; i++) {
    assert.equal(results[`concurrent-${i}`].id, i);
  }
});
