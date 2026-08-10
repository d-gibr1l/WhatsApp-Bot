import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../../src/auth/badMacInterceptor.js';

async function testCase(name, fn) {
  console.log(`\n--- Running Test: ${name} ---`);
  // Handle uncaught exceptions so process doesn't exit abruptly during test run
  const uncaughtHandler = (err) => {
    console.log(`[CAUGHT UNCAUGHT EXCEPTION in ${name}]:`, err);
  };
  process.on('uncaughtException', uncaughtHandler);

  try {
    await fn();
  } catch (err) {
    console.log(`[TEST ERROR in ${name}]:`, err);
  } finally {
    process.off('uncaughtException', uncaughtHandler);
    uninstallBadMacInterceptor();
  }
}

async function main() {
  let purgedKeys = [];
  let wipedJids = [];
  const purgeCorruptKeyMock = async (type, id) => { purgedKeys.push({ type, id }); };
  const getSessionIdMock = () => 'test-session';
  const purgeAllForJidMock = async (jid) => { wipedJids.push(jid); };

  // Test Case A: Plain string rejection "Bad MAC"
  await testCase("Plain String Rejection ('Bad MAC')", async () => {
    purgedKeys = [];
    installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);
    
    const reason = "Bad MAC decrypt failed at async 12345.0 [as awaitable]";
    process.emit('unhandledRejection', reason, Promise.reject(reason).catch(() => {}));
    await new Promise(r => setTimeout(r, 100));
    console.log(`Purged keys count: ${purgedKeys.length}`);
  });

  // Test Case B: Plain object rejection { message: "Bad MAC" }
  await testCase("Plain Object Rejection ({ message: 'Bad MAC' })", async () => {
    purgedKeys = [];
    installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);
    
    const reason = { message: "Bad MAC decrypt failed at async 55555.0 [as awaitable]" };
    process.emit('unhandledRejection', reason, Promise.reject(reason).catch(() => {}));
    await new Promise(r => setTimeout(r, 100));
    console.log(`Purged keys count: ${purgedKeys.length}`);
  });

  // Test Case C: Interaction when index.js listener is registered (listenerCount > 1)
  await testCase("Listener Count > 1 (index.js co-existence)", async () => {
    purgedKeys = [];
    installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);
    
    // Register index.js-like listener
    const indexJsListener = (reason) => {
      console.log("[index.js unhandledRejection listener caught]:", reason?.message || reason);
    };
    process.on('unhandledRejection', indexJsListener);

    // Emit non-BadMAC rejection
    const nonBadMac = new Error("Database connection timeout");
    process.emit('unhandledRejection', nonBadMac, Promise.reject(nonBadMac).catch(() => {}));
    await new Promise(r => setTimeout(r, 100));

    process.off('unhandledRejection', indexJsListener);
  });

  // Test Case D: Rapid fire 10 Bad MAC errors for same JID (Circuit Breaker & Race Conditions)
  await testCase("Rapid Fire Bad MACs (Race condition / Circuit breaker)", async () => {
    purgedKeys = [];
    wipedJids = [];
    installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);

    const promises = [];
    for (let i = 0; i < 10; i++) {
      const err = new Error(`Bad MAC error ${i}\n at async 777777.${i} [as awaitable]`);
      process.emit('unhandledRejection', err, Promise.reject(err).catch(() => {}));
    }
    await new Promise(r => setTimeout(r, 200));
    console.log(`Purged keys: ${purgedKeys.length}, Wiped JIDs: ${wipedJids.length} (${wipedJids.join(', ')})`);
  });

  // Test Case E: Null rejection
  await testCase("Null Rejection", async () => {
    installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);
    process.emit('unhandledRejection', null, Promise.reject(null).catch(() => {}));
    await new Promise(r => setTimeout(r, 100));
  });

  // Test Case F: Console error interceptor when log includes Bad MAC as a string parameter
  await testCase("Console Error Interceptor String Arguments", async () => {
    purgedKeys = [];
    installBadMacInterceptor(purgeCorruptKeyMock, getSessionIdMock, purgeAllForJidMock);
    
    // Baileys logs: console.error("Session error:", "Bad MAC", { stack: "..." })
    console.error("Session error:", "Bad MAC at async 44444.0 [as awaitable]");
    await new Promise(r => setTimeout(r, 100));
    console.log(`Console error interceptor purged keys count: ${purgedKeys.length}`);
  });
}

main().catch(console.error);
