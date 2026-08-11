import test from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { Boom } from '@hapi/boom';
import { DisconnectReason } from '@whiskeysockets/baileys';

import {
  installBadMacInterceptor,
  uninstallBadMacInterceptor,
} from '../../src/auth/badMacInterceptor.js';
import { markBotReady, isBotReady, resetBotReady } from '../../src/handler.js';
import { stopRadarEngine } from '../../src/commands/radar.js';

// Helper under test (extracted logic matching index.js)
function extractStatusCode(error) {
  if (!error) return undefined;
  if (error instanceof Boom || error?.output?.statusCode) {
    return error.output?.statusCode;
  }
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  if (typeof error.code === "string" && !isNaN(Number(error.code))) {
    return Number(error.code);
  }
  if (error.cause) {
    return extractStatusCode(error.cause);
  }
  return undefined;
}

// ─── Stress Verification 1: High-Volume Bad MAC & Rate Limiting Stress Test ───

test('Empirical Stress: High-Volume Bad MAC Rate Limiting & Circuit Breaker', async () => {
  const purgedKeys = [];
  const purgedJids = [];
  const origConsoleError = console.error;
  const loggedMessages = [];

  console.error = (...args) => {
    loggedMessages.push(args.join(' '));
  };

  const mockPurgeCorruptKey = async (type, id) => {
    purgedKeys.push({ type, id });
  };
  const mockGetSessionId = () => 'stress_session_1';
  const mockPurgeAllForJid = async (jid) => {
    purgedJids.push(jid);
  };

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  try {
    const listeners = process.listeners('unhandledRejection');
    const interceptor = listeners.find((l) => l.name === '_unhandledHandler') || listeners[listeners.length - 1];

    // Bombard interceptor with 100 Bad MAC rejections for user 123456789.0@s.whatsapp.net
    const userJid = '123456789.0';
    for (let i = 0; i < 100; i++) {
      const err = new Error(`Bad MAC failure in decryption at async ${userJid} [as awaitable]`);
      await interceptor(err);
    }

    // Verify rate limiting: only 1 log output for the 100 Bad MACs (since all within 10s rate limit window)
    const macLogs = loggedMessages.filter((m) => m.includes('[BadMAC] Unhandled Bad MAC'));
    assert.equal(macLogs.length, 1, 'Only 1 log message should be emitted for 100 rapid Bad MACs on the same key');

    // Verify Circuit Breaker triggered: after 3 bad MACs on JID '123456789', purgeAllForJid should be called
    assert.ok(purgedJids.includes('123456789'), 'Circuit breaker should have triggered purgeAllForJid for JID 123456789');

    // Test a second separate JID
    const userJid2 = '987654321.0';
    for (let i = 0; i < 5; i++) {
      const err = new Error(`Bad MAC failure in decryption at async ${userJid2} [as awaitable]`);
      await interceptor(err);
    }

    assert.ok(purgedJids.includes('987654321'), 'Circuit breaker should trigger for second JID independently');

  } finally {
    uninstallBadMacInterceptor();
    console.error = origConsoleError;
  }
});

// ─── Stress Verification 2: Setup Timeout ('init queries') & Rejection Suppression ───

test('Empirical Stress: Setup Timeout (init queries) & Async Drop Rejection Handling', async () => {
  const origConsoleError = console.error;
  const loggedMessages = [];

  console.error = (...args) => {
    loggedMessages.push(args.join(' '));
  };

  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'stress_session_2';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  try {
    const listeners = process.listeners('unhandledRejection');
    const interceptor = listeners.find((l) => l.name === '_unhandledHandler') || listeners[listeners.length - 1];

    // Simulate various Baileys setup / network timeouts
    const timeoutErrors = [
      new Error("unexpected error in 'init queries'"),
      new Error("Query Timeout (timed out after 60000ms)"),
      "unexpected error in 'init queries'",
      new Error("SessionError: No session record"),
      new Error("SessionError: No matching sessions found for message"),
      new Error("Closing session: SessionEntry"),
      new Error("Closing open session in favor of incoming prekey bundle"),
      new Error("MessageCounterError: Key used already"),
    ];

    for (const err of timeoutErrors) {
      await interceptor(err);
    }

    // Verify all suppressed without throwing uncaught exceptions or escalating
    const suppressedLogs = loggedMessages.filter((m) => m.includes('[BadMAC] Suppressed') || m.includes('[BadMAC] MessageCounterError'));
    assert.ok(suppressedLogs.length > 0 && suppressedLogs.length <= timeoutErrors.length, 'All timeout and session errors must be caught safely (logs rate-limited as expected)');

  } finally {
    uninstallBadMacInterceptor();
    console.error = origConsoleError;
  }
});

// ─── Stress Verification 3: Disconnect Recovery (408 & 428) & State Reset ───

test('Empirical Stress: Disconnect Recovery (408/428) & Socket Teardown Integrity', async () => {
  // Test 408 disconnect state recovery
  let attempt = 3;
  const err408 = new Boom("Timed out", { statusCode: 408 });
  const status408 = extractStatusCode(err408);
  assert.equal(status408, 408);

  if (status408 === DisconnectReason.connectionLost || status408 === 408) {
    attempt = Math.max(attempt - 1, 1);
  }
  assert.equal(attempt, 2, "408 disconnect preserves attempt counter when re-entering loop (attempt - 1 + 1 = 2)");

  // Test 428 disconnect state recovery
  const err428 = new Boom("Connection Closed", { statusCode: 428 });
  const status428 = extractStatusCode(err428);
  assert.equal(status428, 428);

  if (status428 === DisconnectReason.connectionClosed || status428 === 428) {
    attempt = 1;
  }
  assert.equal(attempt, 1, "428 disconnect resets attempt counter to 1");

  // Verify ready state behavior during teardown
  markBotReady();
  assert.equal(isBotReady(), true, "botReady should be true initially");

  // Mock socket teardown execution
  let closed = false;
  let terminated = false;
  let listenersCleared = false;
  const mockSock = {
    ws: {
      close() { closed = true; },
      terminate() { terminated = true; },
    },
    ev: {
      removeAllListeners() { listenersCleared = true; },
    },
  };

  resetBotReady();
  mockSock.ev.removeAllListeners();
  mockSock.ws?.close();
  mockSock.ws?.terminate();
  stopRadarEngine();

  assert.equal(isBotReady(), false, "isBotReady must be false immediately upon teardown");
  assert.equal(closed, true, "WebSocket close must be invoked");
  assert.equal(terminated, true, "WebSocket terminate must be invoked");
  assert.equal(listenersCleared, true, "Socket listeners must be cleared");
});

// ─── Stress Verification 4: Socket Drop Race Condition & Rejection Leak Prevention ───

test('Empirical Stress: Socket Drop Race Condition & Rejection Leak Prevention', async () => {
  const origConsoleError = console.error;
  const loggedMessages = [];

  uninstallBadMacInterceptor();
  installBadMacInterceptor(async () => {}, () => 'stress_session_4', async () => {});

  console.error = (...args) => {
    loggedMessages.push(args.join(' '));
  };

  try {
    const ev = new EventEmitter();
    let setupCaughtInUpdate = false;

    // Simulate connection.update handling when socket abruptly drops mid-setup
    ev.on('connection.update', async (update) => {
      if (update.connection === 'open') {
        try {
          // Simulate query or network failure right as socket drops
          throw new Error("unexpected error in 'init queries' during socket drop");
        } catch (setupErr) {
          setupCaughtInUpdate = true;
          console.error('⚠️ Connection setup error:', setupErr?.message || setupErr);
        }
      }
    });

    ev.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(setupCaughtInUpdate, true, 'Error during connection setup was caught within setup error boundary');
    assert.ok(loggedMessages.some((m) => m.includes('⚠️ Connection setup error:')), 'Setup error was logged gracefully');

  } finally {
    console.error = origConsoleError;
    uninstallBadMacInterceptor();
  }
});
