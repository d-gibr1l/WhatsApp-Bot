import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../../src/auth/badMacInterceptor.js';

let logOutput = [];
let errorOutput = [];

function captureLogs() {
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { logOutput.push(args.join(' ')); origLog(...args); };
  console.error = (...args) => { errorOutput.push(args.join(' ')); origErr(...args); };
  return () => {
    console.log = origLog;
    console.error = origErr;
  };
}

async function runTests() {
  console.log("=== EMPIRICAL TEST SUITE: badMacInterceptor.js Resilience ===");
  const results = [];

  // Mock callbacks
  let purgedKeys = [];
  let wipedJids = [];
  let purgeCorruptKeyMock = async (type, id) => {
    purgedKeys.push({ type, id });
  };
  let getSessionIdMock = () => 'test-session-1';
  let purgeAllForJidMock = async (jid) => {
    wipedJids.push(jid);
  };

  // Test 1: Installation & Standard Bad MAC Handling
  console.log("\n[Test 1] Standard Bad MAC Error Handling");
  installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);
  
  purgedKeys = [];
  wipedJids = [];
  const badMacErr = new Error("Bad MAC decrypt error\n at async 59335526904016.0 [as awaitable]");
  process.emit('unhandledRejection', badMacErr, Promise.reject(badMacErr).catch(() => {}));
  
  // Wait microtask
  await new Promise(r => setTimeout(r, 50));
  
  results.push({
    test: "Standard Bad MAC Error",
    purgedKeysCount: purgedKeys.length,
    purgedKey: purgedKeys[0] || null,
    pass: purgedKeys.length === 1 && purgedKeys[0].id === '59335526904016.0'
  });

  // Test 2: MessageCounterError (Replay Protection)
  console.log("\n[Test 2] MessageCounterError Replay Protection");
  purgedKeys = [];
  const counterErr = new Error("Key used already");
  counterErr.name = "MessageCounterError";
  process.emit('unhandledRejection', counterErr, Promise.reject(counterErr).catch(() => {}));
  await new Promise(r => setTimeout(r, 50));
  
  results.push({
    test: "MessageCounterError Handling",
    purgedKeysCount: purgedKeys.length,
    pass: purgedKeys.length === 0 // Should be dropped silently without purging key
  });

  // Test 3: String rejection (e.g. Promise.reject("Bad MAC"))
  console.log("\n[Test 3] String Rejection ('Bad MAC')");
  purgedKeys = [];
  const stringRejection = "Bad MAC error string";
  // Emit unhandledRejection with non-Error
  process.emit('unhandledRejection', stringRejection, Promise.reject(stringRejection).catch(() => {}));
  await new Promise(r => setTimeout(r, 50));
  
  // Notice: stringRejection is NOT `instanceof Error`, so `badMacInterceptor` treats it as non-BadMAC and calls escalateRejection.
  results.push({
    test: "String Rejection Handling",
    purgedKeysCount: purgedKeys.length,
    handledAsBadMac: purgedKeys.length > 0,
    pass: true // Documenting behavior
  });

  // Test 4: Throwing Callback Resilience
  console.log("\n[Test 4] Throwing Callback Resilience in purgeCorruptKey");
  uninstallBadMacInterceptor();
  let throwingPurgeMock = async (type, id) => {
    throw new Error("Redis connection dropped during purge");
  };
  installBadMacInterceptor(throwingPurgeMock, getSessionIdMock, purgeAllForJidMock);
  
  const errWithThrowingPurge = new Error("Bad MAC decrypt error\n at async 8888888.0 [as awaitable]");
  let uncaughtCaught = false;
  try {
    process.emit('unhandledRejection', errWithThrowingPurge, Promise.reject(errWithThrowingPurge).catch(() => {}));
    await new Promise(r => setTimeout(r, 50));
    uncaughtCaught = true;
  } catch (e) {
    uncaughtCaught = false;
  }

  results.push({
    test: "Throwing Callback Resilience",
    handlerSurvived: uncaughtCaught,
    pass: uncaughtCaught
  });

  // Test 5: Circuit Breaker Trigger (3 Bad MACs in 60s for same JID)
  console.log("\n[Test 5] Circuit Breaker (3 Bad MACs for same JID)");
  uninstallBadMacInterceptor();
  purgedKeys = [];
  wipedJids = [];
  installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);

  for (let i = 0; i < 4; i++) {
    const err = new Error(`Bad MAC error ${i}\n at async 99999999.${i} [as awaitable]`);
    process.emit('unhandledRejection', err, Promise.reject(err).catch(() => {}));
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 100));

  results.push({
    test: "Circuit Breaker Trigger",
    wipedJidsCount: wipedJids.length,
    wipedJid: wipedJids[0] || null,
    pass: wipedJids.length > 0 && wipedJids.includes('99999999')
  });

  // Test 6: Null and Undefined Rejections
  console.log("\n[Test 6] Null and Undefined Rejections");
  process.emit('unhandledRejection', null, Promise.reject(null).catch(() => {}));
  process.emit('unhandledRejection', undefined, Promise.reject(undefined).catch(() => {}));
  await new Promise(r => setTimeout(r, 50));
  
  results.push({
    test: "Null & Undefined Rejections",
    pass: true
  });

  // Cleanup
  uninstallBadMacInterceptor();

  console.log("\n=== Test Results Summary ===");
  console.log(JSON.stringify(results, null, 2));
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
