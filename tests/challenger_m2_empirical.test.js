import test from 'node:test';
import assert from 'node:assert/strict';
import { Boom } from '@hapi/boom';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../src/auth/badMacInterceptor.js';

// ─── HELPER: Format disconnected log string as in index.js ───────────────────
function formatDisconnectLog(lastDisconnect) {
  const statusCode =
    lastDisconnect?.error instanceof Boom
      ? lastDisconnect.error.output.statusCode
      : lastDisconnect?.error?.output?.statusCode;

  const reason =
    Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0]
    ?? "Unknown";

  const errorMsg = lastDisconnect?.error?.message ?? (lastDisconnect?.error ? String(lastDisconnect.error) : "No error details");
  const stackMsg = lastDisconnect?.error?.stack ? `\n${lastDisconnect.error.stack}` : "";
  return `Disconnected: ${reason} (${statusCode}) - Error: ${errorMsg}${stackMsg}`;
}

// ─── TEST 1: index.js Disconnect Formatting Edge Cases ────────────────────────
test('M2 Empirical 1.0 — index.js disconnect error message & stack formatting', () => {
  // Case A: Boom Error with 428 (connectionClosed)
  const boomErr = new Boom('Connection Lost', { statusCode: DisconnectReason.connectionClosed });
  const logA = formatDisconnectLog({ error: boomErr });
  assert.match(logA, /^Disconnected: connectionClosed \(428\) - Error: Connection Lost\nError: Connection Lost/);

  // Case B: Standard Error object with stack trace
  const stdErr = new Error('Socket timeout');
  const logB = formatDisconnectLog({ error: stdErr });
  assert.match(logB, /^Disconnected: Unknown \(undefined\) - Error: Socket timeout\nError: Socket timeout/);

  // Case C: Object error without message/stack (e.g., Baileys disconnect output object)
  const objErr = { output: { statusCode: 515 } };
  const logC = formatDisconnectLog({ error: objErr });
  assert.equal(logC, 'Disconnected: restartRequired (515) - Error: [object Object]');

  // Case D: Primitive string error
  const stringErr = 'Network interface down';
  const logD = formatDisconnectLog({ error: stringErr });
  assert.equal(logD, 'Disconnected: Unknown (undefined) - Error: Network interface down');

  // Case E: Undefined / null lastDisconnect
  const logE1 = formatDisconnectLog(undefined);
  assert.equal(logE1, 'Disconnected: Unknown (undefined) - Error: No error details');

  const logE2 = formatDisconnectLog({});
  assert.equal(logE2, 'Disconnected: Unknown (undefined) - Error: No error details');
});

// ─── TEST 2: Empty JID Circuit Breaker Guard ──────────────────────────────────
test('M2 Empirical 1.1 — Unparseable or empty JID inputs in bad MAC errors', async () => {
  let purgeCorruptKeyCalls = [];
  let purgeAllForJidCalls = [];

  const mockPurgeCorruptKey = async (type, id) => {
    purgeCorruptKeyCalls.push({ type, id });
  };
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async (jid) => {
    purgeAllForJidCalls.push(jid);
  };

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // Test inputs with bad MAC but no valid/extractable JID
  const unparseableInputs = [
    'Bad MAC error occurred',
    'Bad MAC with empty jid: ',
    new Error('Bad MAC failure with no stack or jid'),
    { message: 'Bad MAC error in object', stack: 'Error: Bad MAC\n at foo.js:1:1' },
    { jid: '', message: 'Bad MAC empty jid' },
    { id: null, message: 'Bad MAC null id' },
    { id: 12345, message: 'Bad MAC non-string id' }
  ];

  for (const input of unparseableInputs) {
    console.error(input);
  }

  // Allow any pending async purges to complete
  await new Promise(r => setTimeout(r, 50));

  assert.equal(purgeAllForJidCalls.length, 0, 'purgeAllForJid should NEVER be called for unparseable/empty JIDs');
  assert.equal(purgeCorruptKeyCalls.length, 0, 'purgeCorruptKey should NOT be called when keyInfo is missing or unparseable');

  uninstallBadMacInterceptor();
});

test('M2 Empirical 1.2 — Unhandled rejection listener with unparseable or empty JID', async () => {
  let purgeAllForJidCalls = [];
  let purgeCorruptKeyCalls = [];

  const mockPurgeCorruptKey = async (type, id) => { purgeCorruptKeyCalls.push({ type, id }); };
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async (jid) => { purgeAllForJidCalls.push(jid); };

  uninstallBadMacInterceptor();

  // Find the listener attached by installBadMacInterceptor
  const initialListeners = process.listeners('unhandledRejection');
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);
  const currentListeners = process.listeners('unhandledRejection');
  const installedHandler = currentListeners.find(l => !initialListeners.includes(l));

  assert.ok(installedHandler, 'unhandledRejection handler should be installed');

  // Invoke installedHandler directly with bad MAC error having unparseable JID
  const badMacErrNoJid = new Error('Bad MAC in unhandled promise rejection');
  await installedHandler(badMacErrNoJid);

  assert.equal(purgeAllForJidCalls.length, 0, 'unhandledRejection should not call purgeAllForJid for empty JID');
  assert.equal(purgeCorruptKeyCalls.length, 0, 'unhandledRejection should not call purgeCorruptKey for unparseable JID');

  uninstallBadMacInterceptor();
});

test('M2 Empirical 2.1 — Rate-limiting independence for known JID vs unknown JID', async () => {
  const loggedLines = [];

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();

  const originalConsoleError = console.error;
  console.error = (...args) => {
    loggedLines.push(args.join(' '));
  };

  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // 1. Send unknown JID error twice
  console.error('Bad MAC error with no JID info');
  console.error('Bad MAC error with no JID info second time');

  // Expect: 1st logged, 2nd suppressed (rate limited under unknown_jid)
  assert.equal(loggedLines.length, 1, '1st unknown JID error logged, 2nd rate-limited');
  assert.match(loggedLines[0], /\[BadMAC\] Decryption failure for session 'test_session_m2'\./);
  assert.doesNotMatch(loggedLines[0], /\(key:/); // No key suffix for unknown

  // 2. Now send error for KNOWN JID 1 (123456789.0)
  const knownJidErr1 = new Error('Bad MAC error at async 123456789.0 [as awaitable]');
  console.error(knownJidErr1);
  console.error(knownJidErr1); // 2nd time

  // Expect: 1st for 123456789.0 logged, 2nd for 123456789.0 rate-limited
  assert.equal(loggedLines.length, 2, 'Known JID 1 error was NOT blocked by unknown JID rate-limiting!');
  assert.match(loggedLines[1], /123456789\.0/);

  // 3. Now send error for KNOWN JID 2 (987654321.0)
  const knownJidErr2 = new Error('Bad MAC error at async 987654321.0 [as awaitable]');
  console.error(knownJidErr2);

  assert.equal(loggedLines.length, 3, 'Known JID 2 error was NOT blocked by Known JID 1 rate-limiting!');
  assert.match(loggedLines[2], /987654321\.0/);

  uninstallBadMacInterceptor();
  console.error = originalConsoleError;
});

test('M2 Empirical 2.2 — Circuit breaker scoping per-chat JID', async () => {
  let purgedJids = [];

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async (jid) => {
    purgedJids.push(jid);
  };

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // Trigger 3 bad MAC errors for JID 111111111.0
  const errJid1 = new Error('Bad MAC at async 111111111.0 [as awaitable]');
  console.error(errJid1);
  console.error(errJid1);
  console.error(errJid1);

  await new Promise(r => setTimeout(r, 50));

  assert.equal(purgedJids.length, 1, 'Circuit breaker triggered once for 111111111');
  assert.equal(purgedJids[0], '111111111', 'Base JID correctly extracted as 111111111');

  // Trigger 1 bad MAC error for JID 222222222.0
  const errJid2 = new Error('Bad MAC at async 222222222.0 [as awaitable]');
  console.error(errJid2);

  await new Promise(r => setTimeout(r, 50));

  assert.equal(purgedJids.length, 1, 'JID 222222222 did NOT trigger circuit breaker (only 1 error)');

  uninstallBadMacInterceptor();
});

test('M2 Empirical 3.1 — Intercepting all 7 suppressible error patterns', async () => {
  const loggedLines = [];

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async () => {};

  const testCases = [
    { pattern: 'Bad MAC in message', expectedSubstr: '[BadMAC] Decryption failure' },
    { pattern: 'Key used already for prekey', expectedSubstr: '[BadMAC] Replay protection' },
    { pattern: 'MessageCounterError: counter mismatch', expectedSubstr: '[BadMAC] Replay protection' },
    { pattern: 'Failed to decrypt message from 12345.0', expectedSubstr: '[BadMAC] Suppressed session log (Failed to decrypt message)' },
    { pattern: 'Session error: invalid MAC state', expectedSubstr: '[BadMAC] Suppressed session log (Session error:)' },
    { pattern: 'Closing session: SessionEntry corrupt', expectedSubstr: '[BadMAC] Suppressed session log (Closing session: SessionEntry)' },
    { pattern: 'Closing open session in favor of incoming prekey bundle', expectedSubstr: '[BadMAC] Suppressed session log (Closing open session in favor of incoming prekey bundle)' },
  ];

  for (const tc of testCases) {
    uninstallBadMacInterceptor();
    loggedLines.length = 0;

    const originalConsoleError = console.error;
    console.error = (...args) => { loggedLines.push({ channel: 'error', text: args.join(' ') }); };

    installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

    console.error(tc.pattern);

    assert.equal(loggedLines.length, 1, `Pattern '${tc.pattern}' should produce 1 intercepted log`);
    assert.match(loggedLines[0].text, new RegExp(tc.expectedSubstr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `Pattern '${tc.pattern}' log output mismatch. Got: ${loggedLines[0]?.text}`);

    uninstallBadMacInterceptor();
    console.error = originalConsoleError;
  }
});

test('M2 Empirical 3.2 — Non-suppressible log pass-through', () => {
  const loggedLines = [];

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  const originalConsoleError = console.error;
  console.error = (...args) => { loggedLines.push(args.join(' ')); };

  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  console.error('Database connection failed');
  assert.equal(loggedLines.length, 1, 'Non-suppressible log passes through');
  assert.equal(loggedLines[0], 'Database connection failed', 'Non-suppressible log unchanged');

  uninstallBadMacInterceptor();
  console.error = originalConsoleError;
});

test('M2 Empirical 3.3 — Nested Error and Object matching for suppressible patterns', async () => {
  const loggedLines = [];

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session_m2';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  const originalConsoleError = console.error;
  console.error = (...args) => { loggedLines.push(args.join(' ')); };

  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // Test nested error cause containing suppressible pattern
  const cause = new Error('Failed to decrypt message');
  const outerErr = new Error('Wrapper error');
  outerErr.cause = cause;

  console.error('Error occurred:', outerErr);

  assert.equal(loggedLines.length, 1, 'Nested error cause with suppressible pattern intercepted');
  assert.match(loggedLines[0], /\[BadMAC\] Suppressed session log \(Failed to decrypt message\)/);

  uninstallBadMacInterceptor();
  console.error = originalConsoleError;
});

test('M2 Empirical 4.0 — Throwing getters in error objects cause uncaught exceptions in console.error', () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'sess_poison';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();

  const origErr = console.error;
  console.error = () => {};

  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  try {
    const poisonedObj = {};
    Object.defineProperty(poisonedObj, 'stack', {
      get() { throw new Error('Poisoned property access'); }
    });

    // In a robust logger, passing an object with property access issues should not throw an uncaught exception
    assert.doesNotThrow(
      () => { console.error(poisonedObj); },
      'collectErrorTexts in badMacInterceptor.js handles objects with throwing getters safely'
    );
  } finally {
    console.error = origErr;
    uninstallBadMacInterceptor();
  }
});
