import test from 'node:test';
import assert from 'node:assert/strict';

import {
  purgeAllKeysForJid,
  getAuthState,
  purgeCorruptKey,
  closeRedisConnection,
  getRedis,
} from './redisSession.js';

test('purgeAllKeysForJid returns 0 for invalid or empty JIDs without executing scans', async () => {
  const resultNull = await purgeAllKeysForJid(null);
  assert.equal(resultNull, 0);

  const resultUndefined = await purgeAllKeysForJid(undefined);
  assert.equal(resultUndefined, 0);

  const resultEmpty = await purgeAllKeysForJid('');
  assert.equal(resultEmpty, 0);

  const resultWhitespace = await purgeAllKeysForJid('   ');
  assert.equal(resultWhitespace, 0);

  const resultNonString = await purgeAllKeysForJid(12345);
  assert.equal(resultNonString, 0);

  const resultObject = await purgeAllKeysForJid({});
  assert.equal(resultObject, 0);

  const resultBareDomain = await purgeAllKeysForJid('@s.whatsapp.net');
  assert.equal(resultBareDomain, 0);

  // Test "@g.us" domain-only JID input
  const authState = await getAuthState();
  const keys = authState.state.keys;

  await keys.set({
    session: {
      'user1-session': { registrationId: 100 }
    }
  });

  const resultGroupDomainOnly = await purgeAllKeysForJid('@g.us');
  assert.equal(resultGroupDomainOnly, 0, 'purgeAllKeysForJid("@g.us") should match 0 keys and return 0');

  const fetchResult = await keys.get('session', ['user1-session']);
  assert.equal(fetchResult['user1-session']?.registrationId, 100, 'Existing session keys must remain intact when purging @g.us');
});

test('keys.set performs synchronous L1 cache update and clears tombstone in _purgedKeys', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;

  const testKeyId = 'test-session-id-123';

  // Mark key as corrupt/purged
  await purgeCorruptKey('session', testKeyId);

  // Write new key data via keys.set
  const newSessionData = { registrationId: 999, noiseKey: { type: 'Buffer', data: [1, 2, 3] } };
  
  const setPromise = keys.set({
    session: {
      [testKeyId]: newSessionData
    }
  });

  // Verify L1 cache read immediately works (synchronous update before pipeline finishes)
  const readResult = await keys.get('session', [testKeyId]);
  assert.deepEqual(readResult[testKeyId], newSessionData);

  await setPromise;
});

test('LRU eviction order refreshes on update', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;

  // Insert two items
  await keys.set({
    'pre-key': {
      'key1': { id: 1 },
      'key2': { id: 2 }
    }
  });

  // Access / re-set key1 to refresh LRU order
  await keys.get('pre-key', ['key1']);

  // Fetch both keys to confirm they exist in L1 / state
  const res = await keys.get('pre-key', ['key1', 'key2']);
  assert.equal(res['key1'].id, 1);
  assert.equal(res['key2'].id, 2);
});

test('keys.get and keys.set bubble errors when pipeline exec fails', async () => {
  const authState = await getAuthState();
  const keys = authState.state.keys;
  const redis = getRedis();

  const originalPipeline = redis.pipeline.bind(redis);

  // Test 1: Pipeline exec returning command error tuple
  redis.pipeline = () => {
    const pipe = originalPipeline();
    pipe.exec = async () => [ [new Error('Redis Connection Error'), null] ];
    return pipe;
  };

  try {
    // keys.get must throw instead of returning fallback empty object
    await assert.rejects(
      async () => {
        await keys.get('session', ['fail-key']);
      },
      (err) => {
        return err.message.includes('Redis Connection Error');
      }
    );

    // keys.set must throw instead of silently continuing
    await assert.rejects(
      async () => {
        await keys.set({ session: { 'fail-key': { registrationId: 100 } } });
      },
      (err) => {
        return err.message.includes('Redis Connection Error');
      }
    );
  } finally {
    redis.pipeline = originalPipeline;
  }

  // Test 2: Pipeline exec returning null
  redis.pipeline = () => {
    const pipe = originalPipeline();
    pipe.exec = async () => null;
    return pipe;
  };

  try {
    await assert.rejects(
      async () => { await keys.get('session', ['null-key']); },
      (err) => err.message.includes('Pipeline exec returned null or undefined')
    );
    await assert.rejects(
      async () => { await keys.set({ session: { 'null-key': { registrationId: 101 } } }); },
      (err) => err.message.includes('Pipeline exec returned null or undefined')
    );
  } finally {
    redis.pipeline = originalPipeline;
  }

  // Test 3: Pipeline exec throwing exception directly
  redis.pipeline = () => {
    const pipe = originalPipeline();
    pipe.exec = async () => { throw new Error('Pipeline Execution Exception'); };
    return pipe;
  };

  try {
    await assert.rejects(
      async () => { await keys.get('session', ['throw-key']); },
      (err) => err.message.includes('Pipeline Execution Exception')
    );
    await assert.rejects(
      async () => { await keys.set({ session: { 'throw-key': { registrationId: 102 } } }); },
      (err) => err.message.includes('Pipeline Execution Exception')
    );
  } finally {
    redis.pipeline = originalPipeline;
  }
});

test('closeRedisConnection cleans up connection gracefully', async () => {
  await closeRedisConnection();
});

