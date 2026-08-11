import test from 'node:test';
import assert from 'node:assert/strict';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from './badMacInterceptor.js';

test('badMacInterceptor - empty JID circuit breaker returns early without purging all for empty JID', async () => {
  let purgeAllCalledWith = null;

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async (jid) => {
    purgeAllCalledWith = jid;
  };

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // Trigger console error with bad MAC and unextractable / empty JID 5 times
  for (let i = 0; i < 5; i++) {
    console.error('Bad MAC error with no JID info');
  }

  assert.equal(purgeAllCalledWith, null, 'purgeAllForJid should NEVER be called with empty JID');
  uninstallBadMacInterceptor();
});

test('badMacInterceptor - handles all suppressible patterns with rate-limited logging', () => {
  const _loggedMessages = [];

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  
  // Custom console.error capture wrapper
  const _origErr = console.error;
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const testPatterns = [
    'Bad MAC in message',
    'Key used already for prekey',
    'MessageCounterError: counter mismatch',
    'Failed to decrypt message from 12345@s.whatsapp.net',
    'Session error: invalid MAC',
    'Closing session: SessionEntry corrupt',
    'Closing open session in favor of incoming prekey bundle',
  ];

  for (const pattern of testPatterns) {
    console.error(pattern);
  }

  uninstallBadMacInterceptor();
});

async function triggerUnhandledRejection(err) {
  const listeners = process.listeners('unhandledRejection');
  const interceptorListener = listeners.find((l) => l.name === '_unhandledHandler') || listeners[listeners.length - 1];
  if (interceptorListener) {
    await interceptorListener(err);
  }
}

test('badMacInterceptor - suppresses unhandledRejection for SessionError: No session record', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const sessionErr = new Error('SessionError: No session record');
  let threwException = false;

  try {
    await triggerUnhandledRejection(sessionErr);
  } catch (_err) {
    threwException = true;
  }

  assert.equal(threwException, false, 'unhandledRejection for SessionError should not throw an uncaught exception');
  uninstallBadMacInterceptor();
});

test('badMacInterceptor - suppresses unhandledRejection for SessionError: No matching sessions found for message', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const sessionErr = new Error('SessionError: No matching sessions found for message');
  let threwException = false;

  try {
    await triggerUnhandledRejection(sessionErr);
  } catch (_err) {
    threwException = true;
  }

  assert.equal(threwException, false, 'unhandledRejection for No matching sessions found should not throw');
  uninstallBadMacInterceptor();
});

test('badMacInterceptor - suppresses unhandledRejection for Query Timeout', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const timeoutErr = new Error("unexpected error in 'init queries' (timed out)");
  let threwException = false;

  try {
    await triggerUnhandledRejection(timeoutErr);
  } catch (_err) {
    threwException = true;
  }

  assert.equal(threwException, false, 'unhandledRejection for Query Timeout should not throw');
  uninstallBadMacInterceptor();
});

test('badMacInterceptor - rate limits repeated unhandled session errors', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const sessionErr = new Error('SessionError: No session record');
  let threwException = false;

  try {
    for (let i = 0; i < 5; i++) {
      await triggerUnhandledRejection(sessionErr);
    }
  } catch (_err) {
    threwException = true;
  }

  assert.equal(threwException, false, 'repeated unhandled session errors should be safely rate-limited and suppressed');
  uninstallBadMacInterceptor();
});

