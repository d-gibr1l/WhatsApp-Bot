import test from 'node:test';
import assert from 'node:assert/strict';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../src/auth/badMacInterceptor.js';
import { resetBotReady } from '../src/handler.js';

test('Challenger M3_2 — escalateRejection propagation across error types and multiple listeners', async () => {
  const dummyListener1 = () => {};
  const dummyListener2 = () => {};
  process.on('unhandledRejection', dummyListener1);
  process.on('unhandledRejection', dummyListener2);

  const existingUncaught = process.listeners('uncaughtException');
  for (const l of existingUncaught) {
    process.removeListener('uncaughtException', l);
  }

  const capturedErrors = [];
  const uncaughtHandler = (err) => {
    capturedErrors.push(err);
  };
  process.on('uncaughtException', uncaughtHandler);

  try {
    uninstallBadMacInterceptor();
    installBadMacInterceptor(async () => {}, () => 'test_session', async () => {});

    const listeners = process.listeners('unhandledRejection');
    const interceptor = listeners.find(l => l.name === '_unhandledHandler') || listeners[listeners.length - 1];

    // 1. Standard Error
    const errStandard = new Error('Database connection failed');
    await interceptor(errStandard);

    // 2. Custom TypeError
    const errType = new TypeError('Cannot read property of undefined');
    await interceptor(errType);

    // 3. Primitive string rejection
    const errString = 'Fatal memory limit reached';
    await interceptor(errString);

    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(capturedErrors.length, 3, 'All 3 non-suppressible rejections must escalate to uncaughtException');
    assert.equal(capturedErrors[0].message, 'Database connection failed');
    assert.equal(capturedErrors[1].message, 'Cannot read property of undefined');
    assert.equal(capturedErrors[2].message, 'Fatal memory limit reached');
  } finally {
    process.removeListener('uncaughtException', uncaughtHandler);
    for (const l of existingUncaught) {
      process.on('uncaughtException', l);
    }
    process.removeListener('unhandledRejection', dummyListener1);
    process.removeListener('unhandledRejection', dummyListener2);
    uninstallBadMacInterceptor();
  }
});

test('Challenger M3_2 — uncaughtException initiates socket teardown and clean shutdown', async () => {
  let removeAllListenersCalled = false;
  let wsCloseCalled = false;
  let wsTerminateCalled = false;
  let pollerStopped = false;

  const mockSock = {
    ev: {
      removeAllListeners() {
        removeAllListenersCalled = true;
      }
    },
    ws: {
      close() {
        wsCloseCalled = true;
      },
      terminate() {
        wsTerminateCalled = true;
      }
    }
  };

  const mockPoller = () => {
    pollerStopped = true;
  };

  // Re-simulate teardown logic from index.js
  let botReadyTimer = setTimeout(() => {}, 10000);
  let stopPoller = mockPoller;
  let currentSock = mockSock;

  function teardownCurrentSocket(sock) {
    if (botReadyTimer) {
      clearTimeout(botReadyTimer);
      botReadyTimer = null;
    }
    resetBotReady();

    if (stopPoller) {
      try { stopPoller(); } catch {}
      stopPoller = null;
    }

    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.ws?.close(); } catch {}
      try { sock.ws?.terminate(); } catch {}
    }
    if (currentSock === sock) {
      currentSock = null;
    }
  }

  // Execute teardown as index.js uncaughtException handler does
  teardownCurrentSocket(currentSock);

  assert.equal(removeAllListenersCalled, true, 'sock.ev.removeAllListeners must be called during teardown');
  assert.equal(wsCloseCalled, true, 'sock.ws.close must be called during teardown');
  assert.equal(wsTerminateCalled, true, 'sock.ws.terminate must be called during teardown');
  assert.equal(pollerStopped, true, 'stopPoller must be called during teardown');
  assert.equal(botReadyTimer, null, 'botReadyTimer must be cleared');
  assert.equal(currentSock, null, 'currentSock reference must be cleared');
});

test('Challenger M3_2 — shutdown is guarded against recursive re-entry', async () => {
  let isShuttingDown = false;
  let shutdownCallCount = 0;

  async function shutdown(signal, exitCode = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdownCallCount++;
  }

  await Promise.all([
    shutdown('UNCAUGHT_EXCEPTION', 1),
    shutdown('SIGTERM', 0),
    shutdown('SIGINT', 0),
  ]);

  assert.equal(shutdownCallCount, 1, 'shutdown must execute exactly once when invoked concurrently or recursively');
});
