import test from 'node:test';
import assert from 'node:assert/strict';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../src/auth/badMacInterceptor.js';

async function triggerUnhandledRejection(err) {
  const listeners = process.listeners('unhandledRejection');
  const interceptorListener = listeners.find((l) => l.name === '_unhandledHandler') || listeners[listeners.length - 1];
  if (interceptorListener) {
    await interceptorListener(err);
  }
}

test('Challenger M1_2 - Edge Case: Circular Reference Error Objects', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // Direct circular reference
  const err1 = new Error('SessionError: No session record');
  err1.cause = err1;
  err1.reason = err1;

  // Mutual circular reference
  const errA = new Error('Outer error');
  const errB = new Error('Session error: Bad MAC');
  errA.cause = errB;
  errB.cause = errA;
  errA.err = errB;
  errB.err = errA;

  let threwInternalException = false;

  try {
    await triggerUnhandledRejection(err1);
    await triggerUnhandledRejection(errA);
  } catch (_ex) {
    threwInternalException = true;
  }

  assert.equal(threwInternalException, false, 'Circular references should be traversed safely without stack overflow or internal exception');
  uninstallBadMacInterceptor();
});

test('Challenger M1_2 - Edge Case: Custom toString() Overrides and Throwing Getters', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // Object with throwing toString()
  const throwingToStringErr = {
    message: 'SessionError: No matching sessions found',
    toString() {
      throw new Error('Custom toString exploded');
    }
  };

  // Object with throwing property getters
  const throwingGetterErr = {
    get stack() {
      throw new Error('Stack getter exploded');
    },
    get message() {
      return 'Bad MAC failure';
    },
    get cause() {
      throw new Error('Cause getter exploded');
    }
  };

  let threwInternalException = false;

  try {
    await triggerUnhandledRejection(throwingToStringErr);
    await triggerUnhandledRejection(throwingGetterErr);
  } catch (_ex) {
    threwInternalException = true;
  }

  assert.equal(threwInternalException, false, 'Custom throwing toString() or getters should be caught safely by safeAccess');
  uninstallBadMacInterceptor();
});

test('Challenger M1_2 - Edge Case: Deep Cause Chains', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // 4-level deep cause chain
  const level4 = new Error('SessionError: No session record');
  const level3 = { cause: level4, message: 'Wrapper 3' };
  const level2 = { reason: level3, message: 'Wrapper 2' };
  const level1 = { err: level2, message: 'Top Wrapper' };

  let threwInternalException = false;

  try {
    await triggerUnhandledRejection(level1);
  } catch (_ex) {
    threwInternalException = true;
  }

  assert.equal(threwInternalException, false, 'Deep cause chains containing SessionError should be collected and suppressed');
  uninstallBadMacInterceptor();
});

test('Challenger M1_2 - Edge Case: Null and Undefined Reasons', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  const existingUncaught = process.listeners('uncaughtException');
  for (const l of existingUncaught) {
    process.removeListener('uncaughtException', l);
  }
  const nopUncaught = () => {};
  process.on('uncaughtException', nopUncaught);

  let threwInternalException = false;

  try {
    await triggerUnhandledRejection(null);
    await triggerUnhandledRejection(undefined);
    await new Promise(r => setTimeout(r, 20));
  } catch (_ex) {
    threwInternalException = true;
  } finally {
    process.removeListener('uncaughtException', nopUncaught);
    for (const l of existingUncaught) {
      process.on('uncaughtException', l);
    }
  }

  assert.equal(threwInternalException, false, 'null and undefined rejection reasons should not throw internal TypeError inside _unhandledHandler');
  uninstallBadMacInterceptor();
});

test('Challenger M1_2 - Edge Case: String-Only Rejections', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  let threwInternalException = false;

  try {
    await triggerUnhandledRejection('SessionError: No session record');
    await triggerUnhandledRejection('Bad MAC');
    await triggerUnhandledRejection("unexpected error in 'init queries' (timed out)");
  } catch (_ex) {
    threwInternalException = true;
  }

  assert.equal(threwInternalException, false, 'String-only rejections should be recognized and suppressed without throwing');
  uninstallBadMacInterceptor();
});

test('Challenger M1_2 - Edge Case: Non-Standard Objects and Primitives', async () => {
  const mockPurgeCorruptKey = async () => {};
  const mockGetSessionId = () => 'test_session';
  const mockPurgeAllForJid = async () => {};

  uninstallBadMacInterceptor();
  installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

  // Object without prototype
  const bareObj = Object.create(null);
  bareObj.message = 'SessionError: No session record';

  // Proxy object that throws on unhandled property access
  const proxyObj = new Proxy({ message: 'Bad MAC' }, {
    get(target, prop) {
      if (prop === 'cause') throw new Error('Proxy trapped cause access');
      return target[prop];
    }
  });

  const existingUncaught = process.listeners('uncaughtException');
  for (const l of existingUncaught) {
    process.removeListener('uncaughtException', l);
  }
  const nopUncaught = () => {};
  process.on('uncaughtException', nopUncaught);

  let threwInternalException = false;

  try {
    await triggerUnhandledRejection(42);
    await triggerUnhandledRejection(true);
    await triggerUnhandledRejection(Symbol('test'));
    await triggerUnhandledRejection(bareObj);
    await triggerUnhandledRejection(proxyObj);
    await new Promise(r => setTimeout(r, 20));
  } catch (_ex) {
    threwInternalException = true;
  } finally {
    process.removeListener('uncaughtException', nopUncaught);
    for (const l of existingUncaught) {
      process.on('uncaughtException', l);
    }
  }

  assert.equal(threwInternalException, false, 'Non-standard objects, proxies, and primitives should not crash _unhandledHandler');
  uninstallBadMacInterceptor();
});
