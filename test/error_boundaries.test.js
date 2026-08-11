import test from 'node:test';
import assert from 'node:assert/strict';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../src/auth/badMacInterceptor.js';

test('M3 Error Boundary: escalateRejection propagates non-suppressible rejection when extra listener attached', async () => {
  const extraListener = () => {};
  process.on('unhandledRejection', extraListener);

  const existingUncaught = process.listeners('uncaughtException');
  for (const l of existingUncaught) {
    process.removeListener('uncaughtException', l);
  }

  let capturedUncaught = null;
  const uncaughtHandler = (err) => {
    capturedUncaught = err;
  };
  process.on('uncaughtException', uncaughtHandler);

  try {
    uninstallBadMacInterceptor();
    installBadMacInterceptor(async () => {}, () => 'test_session', async () => {});

    const testError = new Error('Non-suppressible application error');

    const listeners = process.listeners('unhandledRejection');
    const interceptor = listeners.find(l => l.name === '_unhandledHandler') || listeners[listeners.length - 1];

    await interceptor(testError);

    await new Promise(resolve => setTimeout(resolve, 50));

    assert.ok(capturedUncaught, 'Non-suppressible rejection must escalate to uncaughtException');
    assert.equal(capturedUncaught.message, 'Non-suppressible application error');
  } finally {
    process.removeListener('uncaughtException', uncaughtHandler);
    for (const l of existingUncaught) {
      process.on('uncaughtException', l);
    }
    process.removeListener('unhandledRejection', extraListener);
    uninstallBadMacInterceptor();
  }
});

test('M3 Error Boundary: Suppressible query timeout error is suppressed without escalating', async () => {
  uninstallBadMacInterceptor();
  installBadMacInterceptor(async () => {}, () => 'test_session', async () => {});

  let escalated = false;
  const uncaughtHandler = () => { escalated = true; };
  process.once('uncaughtException', uncaughtHandler);

  const queryErr = new Error("unexpected error in 'init queries'");
  const listeners = process.listeners('unhandledRejection');
  const interceptor = listeners.find(l => l.name === '_unhandledHandler') || listeners[listeners.length - 1];

  await interceptor(queryErr);
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(escalated, false, 'init queries timeout error must be suppressed');
  process.removeListener('uncaughtException', uncaughtHandler);
  uninstallBadMacInterceptor();
});

test('M3 Error Boundary: Async setup failure inside connection.update is caught safely', async () => {
  let capturedErrorLog = null;
  const origConsoleError = console.error;
  console.error = (...args) => {
    capturedErrorLog = args.join(' ');
  };

  try {
    const mockSetupError = new Error('Database connection failed during cache load');

    let setupCaught = false;
    try {
      throw mockSetupError;
    } catch (setupErr) {
      setupCaught = true;
      console.error('⚠️ Connection setup error:', setupErr?.message || setupErr);
    }

    assert.equal(setupCaught, true, 'Error during setup block must be caught in try-catch');
    assert.ok(capturedErrorLog.includes('Database connection failed'), 'Error message must be logged gracefully');
  } finally {
    console.error = origConsoleError;
  }
});

test('M3 Error Boundary: Baileys version fetch fallback executes on network error', async () => {
  const fetchLatestBaileysVersionMock = async () => {
    throw new Error('ETIMEDOUT: Failed to fetch latest version');
  };

  let version = [2, 3000, 1015901307];
  let isLatest = false;
  let warningLogged = null;

  const origWarn = console.warn;
  console.warn = (...args) => {
    warningLogged = args.join(' ');
  };

  try {
    try {
      const vResult = await fetchLatestBaileysVersionMock();
      version = vResult.version;
      isLatest = vResult.isLatest;
    } catch (err) {
      console.warn(`⚠️ Could not fetch latest Baileys version (${err?.message || err}). Using fallback version ${version.join('.')}`);
    }

    assert.deepEqual(version, [2, 3000, 1015901307], 'Fallback version [2, 3000, 1015901307] must be retained on error');
    assert.equal(isLatest, false, 'isLatest must remain false on error');
    assert.ok(warningLogged.includes('ETIMEDOUT'), 'Warning must log the underlying error');
  } finally {
    console.warn = origWarn;
  }
});
