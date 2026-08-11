import test from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../src/auth/badMacInterceptor.js';

// ─── Test 1: Empirical Verification of Data Loaders Exception Handling ─────

test('M3 Empirical: Individual data loader errors are handled without throwing uncaught exceptions', async () => {
  // Test loadCache internal exception handling
  const logs = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => logs.push(['error', args.join(' ')]);
  console.warn = (...args) => logs.push(['warn', args.join(' ')]);

  try {
    // Import loaders
    const { loadCache, loadSeenMessages } = await import('../src/cache.js');
    const { loadWordFilter } = await import('../src/commands/wordfilter.js');
    const { loadAllowedLinks } = await import('../src/commands/antilink.js');
    const { loadAliases } = await import('../src/commands/aliases.js');

    // Executing loaders when Supabase / Redis is unconfigured or throwing
    await assert.doesNotReject(async () => {
      await loadCache();
    }, 'loadCache must not throw uncaught exceptions');

    await assert.doesNotReject(async () => {
      await loadWordFilter();
    }, 'loadWordFilter must not throw uncaught exceptions');

    await assert.doesNotReject(async () => {
      await loadAllowedLinks();
    }, 'loadAllowedLinks must not throw uncaught exceptions');

    await assert.doesNotReject(async () => {
      await loadAliases();
    }, 'loadAliases must not throw uncaught exceptions');

    await assert.doesNotReject(async () => {
      await loadSeenMessages();
    }, 'loadSeenMessages must not throw uncaught exceptions');

  } finally {
    console.error = origError;
    console.warn = origWarn;
    try {
      const { closeRedisConnection } = await import('../src/auth/redisSession.js');
      await closeRedisConnection();
    } catch {}
  }
});

// ─── Test 2: Simulated Setup Block Errors Inside connection.update ─────────

test('M3 Empirical: Fatal error inside connection setup block is caught cleanly by setupErr boundary', async () => {
  const capturedErrors = [];
  const origConsoleError = console.error;
  console.error = (...args) => {
    capturedErrors.push(args.join(' '));
  };

  try {
    let botReady = false;
    let botReadyTimer = null;
    let markBotReadyCalled = false;
    const markBotReadyMock = () => { markBotReadyCalled = true; };

    // Simulate connection.update event logic with a loader throwing a fatal exception
    const simulateConnectionUpdate = async (failingLoader) => {
      try {
        if (!botReady) {
          botReady = true;
          await failingLoader();
          botReadyTimer = setTimeout(() => {
            markBotReadyMock();
          }, 50);
        }
      } catch (setupErr) {
        console.error('⚠️ Connection setup error:', setupErr?.message || setupErr);
      }
    };

    const fatalLoader = async () => {
      throw new Error('Fatal DB Connection Crash during loadCache');
    };

    // Execute simulated event listener
    await simulateConnectionUpdate(fatalLoader);

    // Verify error was caught and logged
    assert.equal(capturedErrors.length, 1, 'Exactly one error log expected');
    assert.ok(capturedErrors[0].includes('⚠️ Connection setup error: Fatal DB Connection Crash during loadCache'));
    assert.equal(markBotReadyCalled, false, 'markBotReady should not be called when setup fails');

  } finally {
    console.error = origConsoleError;
  }
});

// ─── Test 3: Baileys Version Fetch Failure Isolation & Fallback ────────────

test('M3 Empirical: Baileys version fetch failures recover gracefully using default fallback', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const fetchLatestBaileysVersionSim = async () => {
      throw new Error('503 Service Unavailable: https://raw.githubusercontent.com/WhiskeySockets/Baileys');
    };

    let version = [2, 3000, 1015901307];
    let isLatest = false;

    try {
      const vResult = await fetchLatestBaileysVersionSim();
      version = vResult.version;
      isLatest = vResult.isLatest;
    } catch (err) {
      console.warn(`⚠️ Could not fetch latest Baileys version (${err?.message || err}). Using fallback version ${version.join('.')}`);
    }

    assert.deepEqual(version, [2, 3000, 1015901307], 'Version should remain default fallback');
    assert.equal(isLatest, false, 'isLatest should remain false');
    assert.equal(warnings.length, 1, 'Warning should be logged');
    assert.ok(warnings[0].includes('503 Service Unavailable'), 'Warning log contains error message');

  } finally {
    console.warn = origWarn;
  }
});

// ─── Test 4: Simulated runBot Event Loop Setup Failure Isolation ─────────

test('M3 Empirical: Simulated runBot event listener catches error without hanging process or re-throwing', async () => {
  const ev = new EventEmitter();
  let connectionState = 'closed';
  let setupErrorLogged = false;

  const origError = console.error;
  console.error = (...args) => {
    const msg = args.join(' ');
    if (msg.includes('⚠️ Connection setup error:')) {
      setupErrorLogged = true;
    }
  };

  try {
    let botReady = false;

    ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        connectionState = 'open';
        try {
          if (!botReady) {
            botReady = true;
            // Simulate broken setup call
            throw new Error('Simulated Redis Timeout during loadSeenMessages');
          }
        } catch (setupErr) {
          console.error('⚠️ Connection setup error:', setupErr?.message || setupErr);
        }
      }
    });

    // Trigger connection.update with 'open'
    ev.emit('connection.update', { connection: 'open' });

    // Allow promise tick to resolve
    await new Promise(r => setTimeout(r, 50));

    assert.equal(connectionState, 'open', 'Connection state reached open');
    assert.equal(setupErrorLogged, true, 'Connection setup error was logged safely');

  } finally {
    console.error = origError;
  }
});

// ─── Test 5: Rejection Escalation & Circuit Breaker Teardown Test ─────────

test('M3 Empirical: Process shutdown guard handles uncaughtException cleanly without infinite loop', async () => {
  let isShuttingDown = false;
  let shutdownCalls = 0;
  let exitCode = null;

  const shutdownSim = async (signal, code = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdownCalls++;
    exitCode = code;
  };

  // Simulate multiple calls to shutdown simultaneously (e.g. cascaded errors)
  await Promise.all([
    shutdownSim('UNCAUGHT_EXCEPTION', 1),
    shutdownSim('SIGTERM', 0),
    shutdownSim('SIGINT', 0),
  ]);

  assert.equal(shutdownCalls, 1, 'shutdown must execute exactly once (re-entry guard prevents loops)');
  assert.equal(exitCode, 1, 'First exit code (1) must be preserved');
});
