import test from 'node:test';
import assert from 'node:assert/strict';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../src/auth/badMacInterceptor.js';

test('M2 Edge Cases — JID Regex Extraction & Formatting', () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();

  const loggedLines = [];
  const origErr = console.error;
  console.error = (...args) => loggedLines.push(args.join(' '));

  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const jidTestCases = [
    {
      input: 'Error at async 123456789.0 [as awaitable]',
      expectedKey: '123456789.0'
    },
    {
      input: 'Error address: 987654321.2',
      expectedKey: '987654321.2'
    },
    {
      input: 'Error from 555444333@s.whatsapp.net',
      expectedKey: '555444333.0'
    },
    {
      input: 'Error from 555444333:2@s.whatsapp.net',
      expectedKey: '555444333.2'
    },
    {
      input: 'Error from 777888999@lid',
      expectedKey: '777888999.0'
    },
    {
      input: 'Error from group 123456789-987654@g.us',
      expectedKey: '123456789-987654@g.us'
    }
  ];

  for (const tc of jidTestCases) {
    loggedLines.length = 0;
    console.error(`Bad MAC failure: ${tc.input}`);

    assert.equal(loggedLines.length, 1, `JID input '${tc.input}' should produce 1 log line`);
    assert.match(loggedLines[0], new RegExp(`\\(key: ${tc.expectedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
      `Expected key '${tc.expectedKey}' in log output. Got: ${loggedLines[0]}`);
  }

  uninstallBadMacInterceptor();
  console.error = origErr;
});

test('M2 Edge Cases — In-flight Wipe Deduplication (_wipesInFlight)', async () => {
  let purgeAllForJidCallCount = 0;
  let slowWipeResolve = null;

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async (jid) => {
    purgeAllForJidCallCount++;
    return new Promise(resolve => {
      slowWipeResolve = resolve;
    });
  };

  uninstallBadMacInterceptor();
  const origErr = console.error;
  console.error = () => {};

  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const errJid = new Error('Bad MAC at async 444444444.0 [as awaitable]');

  // Fire 4 errors in rapid succession for JID 444444444.0
  console.error(errJid); // count 1
  console.error(errJid); // count 2
  console.error(errJid); // count 3 -> triggers circuit breaker, wipe in-flight
  console.error(errJid); // count 4 -> should collapse into existing in-flight wipe Promise!

  await new Promise(r => setTimeout(r, 20));

  assert.equal(purgeAllForJidCallCount, 1, 'purgeAllForJid should only be initiated ONCE for in-flight wipe');

  // Complete slow wipe
  if (slowWipeResolve) slowWipeResolve();
  await new Promise(r => setTimeout(r, 20));

  uninstallBadMacInterceptor();
  console.error = origErr;
});

test('M2 Edge Cases — Circuit breaker error handling and count recovery', async () => {
  let callCount = 0;

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async (jid) => {
    callCount++;
    throw new Error('Redis connection lost during wipe');
  };

  uninstallBadMacInterceptor();
  const origErr = console.error;
  console.error = () => {};

  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const errJid = new Error('Bad MAC at async 555555555.0 [as awaitable]');

  console.error(errJid); // count 1
  console.error(errJid); // count 2
  console.error(errJid); // count 3 -> triggers circuit breaker, fails

  await new Promise(r => setTimeout(r, 50));

  assert.equal(callCount, 1, 'purgeAllForJid called once and failed gracefully without crashing');

  uninstallBadMacInterceptor();
  console.error = origErr;
});
