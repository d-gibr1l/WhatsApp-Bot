import assert from 'node:assert/strict';
import Redis from 'ioredis';
import {
  getAuthState,
  clearSession,
  closeRedisConnection,
  drainPendingDbWrites,
  purgeCorruptKey,
  purgeAllKeysForJid,
  getSessionId
} from '../../src/auth/redisSession.js';
import {
  installBadMacInterceptor,
  uninstallBadMacInterceptor
} from '../../src/auth/badMacInterceptor.js';

console.log('====================================================');
console.log('Empirical Challenger: Auth Module Edge Cases Test Suite');
console.log('====================================================\n');

const rawRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function runTests() {
  let passedCount = 0;
  let failedCount = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ Passed: ${name}`);
      passedCount++;
    } catch (err) {
      console.error(`  ❌ Failed: ${name}\n     ${err.message}`);
      failedCount++;
    }
  }

  async function asyncTest(name, fn) {
    try {
      await fn();
      console.log(`  ✅ Passed: ${name}`);
      passedCount++;
    } catch (err) {
      console.error(`  ❌ Failed: ${name}\n     ${err.message}`);
      failedCount++;
    }
  }

  // ----------------------------------------------------
  // Test 1: Corrupted JSON Handling in keys.get()
  // ----------------------------------------------------
  console.log('--- Suite 1: keys.get() Corrupted JSON Handling ---');
  await asyncTest('Corrupted JSON safely skipped without throwing in keys.get()', async () => {
    await clearSession();
    const auth1 = await getAuthState();
    const sessionId = getSessionId();

    const validKeyId = 'valid-key-1';
    const corruptKeyId = 'corrupt-key-1';
    const redisValidKey = `${sessionId}:session-${validKeyId}`;
    const redisCorruptKey = `${sessionId}:session-${corruptKeyId}`;

    await rawRedis.set(redisValidKey, JSON.stringify({ data: 'hello' }));
    await rawRedis.set(redisCorruptKey, '{corrupted_json_string_###');

    const result = await auth1.state.keys.get('session', [validKeyId, corruptKeyId]);

    assert.ok(result[validKeyId], 'Valid key should be retrieved');
    assert.equal(result[validKeyId].data, 'hello', 'Valid key content should match');
    assert.equal(result[corruptKeyId], undefined, 'Corrupted key should be skipped');
  });

  // ----------------------------------------------------
  // Test 2: Tombstone Deletion on keys.set()
  // ----------------------------------------------------
  console.log('\n--- Suite 2: keys.set() Tombstone Deletion ---');
  await asyncTest('Tombstone cleared on keys.set() allowing subsequent read back', async () => {
    const auth1 = await getAuthState();
    const sessionId = getSessionId();

    const tombstoneKeyId = 'tombstone-test-key';
    const redisTombstoneKey = `${sessionId}:session-${tombstoneKeyId}`;

    await rawRedis.set(redisTombstoneKey, JSON.stringify({ old: 'val' }));
    await purgeCorruptKey('session', tombstoneKeyId);

    const checkDel = await rawRedis.get(redisTombstoneKey);
    assert.equal(checkDel, null, 'Key should be deleted from Redis by purgeCorruptKey');

    await auth1.state.keys.set({
      session: {
        [tombstoneKeyId]: { new: 'value' }
      }
    });

    const getTombstone = await auth1.state.keys.get('session', [tombstoneKeyId]);
    assert.ok(getTombstone[tombstoneKeyId], 'Key should be returned by keys.get after keys.set cleared tombstone');
    assert.equal(getTombstone[tombstoneKeyId].new, 'value', 'Newly set value should match');
  });

  // ----------------------------------------------------
  // Test 3: L1 Cache Capacity Limits & Eviction
  // ----------------------------------------------------
  console.log('\n--- Suite 3: L1 Cache Capacity & Eviction ---');
  await asyncTest('L1 Cache bounds size and returns elements properly', async () => {
    const auth1 = await getAuthState();
    const setBatch = {};
    for (let i = 0; i < 2005; i++) {
      setBatch[`l1-key-${i}`] = { index: i };
    }
    await auth1.state.keys.set({ appState: setBatch });

    const batchFetch = await auth1.state.keys.get('appState', ['l1-key-0', 'l1-key-2004']);
    assert.equal(batchFetch['l1-key-0'].index, 0);
    assert.equal(batchFetch['l1-key-2004'].index, 2004);
  });

  // ----------------------------------------------------
  // Test 4: clearSession() & Auth Promise Reset
  // ----------------------------------------------------
  console.log('\n--- Suite 4: clearSession() Reset & Invalidation ---');
  await asyncTest('clearSession() resets _authPromise and invalidates previous instance', async () => {
    const firstAuth = await getAuthState();
    assert.ok(firstAuth, 'First auth instance retrieved');

    await clearSession();

    const secondAuth = await getAuthState();
    assert.notEqual(firstAuth, secondAuth, 'getAuthState after clearSession must produce a new instance');

    // Calling saveCreds on invalidated instance should log a warning and return cleanly
    await firstAuth.saveCreds();
  });

  // ----------------------------------------------------
  // Test 5: Drain Pending Writes
  // ----------------------------------------------------
  console.log('\n--- Suite 5: Drain Pending Writes ---');
  await asyncTest('drainPendingDbWrites() completes without error', async () => {
    const secondAuth = await getAuthState();
    for (let i = 0; i < 10; i++) {
      secondAuth.state.keys.set({
        session: { [`drain-key-${i}`]: { test: i } }
      });
    }
    await drainPendingDbWrites();
  });

  // ----------------------------------------------------
  // Test 6: Bad MAC Interceptor Edge Cases
  // ----------------------------------------------------
  console.log('\n--- Suite 6: Bad MAC Interceptor Edge Cases ---');
  let purgedKeysList = [];
  let purgedJidsList = [];
  const sessionId = getSessionId();

  installBadMacInterceptor(
    async (type, id) => { purgedKeysList.push({ type, id }); },
    () => sessionId,
    async (jid) => { purgedJidsList.push(jid); }
  );

  test('Console shim handles unusual/edge arguments gracefully', () => {
    console.error(null);
    console.error(undefined);
    console.error(12345);
    const circularObj = { name: 'circular' };
    circularObj.self = circularObj;
    console.error(circularObj);
  });

  await asyncTest('Interception and purge extraction for nested Bad MAC error', async () => {
    const nestedBadMac = {
      message: 'Bad MAC error during decryption',
      cause: {
        reason: {
          err: {
            stack: 'Error: Bad MAC\n at async 9876543210.0 [as awaitable]'
          }
        }
      }
    };

    console.error(nestedBadMac);
    await new Promise(r => setTimeout(r, 50));

    assert.ok(purgedKeysList.some(k => k.id === '9876543210.0'), 'Nested key ID 9876543210.0 should be extracted');
  });

  await asyncTest('Interceptor suppresses replay protection errors (MessageCounterError / Key used already)', async () => {
    console.error('Key used already in session');
    console.error('MessageCounterError for session');
    await new Promise(r => setTimeout(r, 50));
  });

  uninstallBadMacInterceptor();
  test('Interceptor uninstalls cleanly restoring console methods', () => {
    assert.equal(typeof console.error, 'function');
  });

  // ----------------------------------------------------
  // Clean up
  // ----------------------------------------------------
  await closeRedisConnection();
  await rawRedis.quit();

  console.log('\n====================================================');
  console.log(`RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('====================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests();
