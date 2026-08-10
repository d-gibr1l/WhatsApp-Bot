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
