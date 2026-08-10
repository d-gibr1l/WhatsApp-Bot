import { spawn } from 'child_process';
import path from 'path';
import fileUrl from 'url';

const projectRoot = 'C:\\Users\\domin\\Desktop\\my-whatsapp-bot-main';

function runNodeSubprocess(code, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = spawn('node', ['--input-type=module', '-e', code], {
      cwd: projectRoot,
      env: { ...process.env, PORT: '0' } // use random available port for server
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
}

async function main() {
  console.log("=== EMPIRICAL TEST SUITE: Import Boundaries & Exit Behavior ===");
  const results = [];

  // Test 1: Importing src/server.js alone — does it keep event loop open?
  console.log("\n[Test 1] Importing src/server.js event loop persistence test");
  const serverImportRes = await runNodeSubprocess(`
    import * as server from './src/server.js';
    console.log('[Subprocess] server.js imported successfully');
  `, 2500);

  results.push({
    test: "src/server.js Import Event Loop Hold",
    timedOut: serverImportRes.timedOut,
    stdout: serverImportRes.stdout.trim(),
    stderr: serverImportRes.stderr.trim(),
    pass: serverImportRes.timedOut === true,
    note: serverImportRes.timedOut ? "setInterval(broadcastStats) keeps event loop active as expected" : "Event loop exited unexpectedly"
  });

  // Test 2: Importing badMacInterceptor.js alone — does it unref timers and exit cleanly?
  console.log("\n[Test 2] Importing src/auth/badMacInterceptor.js exit test");
  const interceptorImportRes = await runNodeSubprocess(`
    import { installBadMacInterceptor, uninstallBadMacInterceptor } from './src/auth/badMacInterceptor.js';
    installBadMacInterceptor(() => {}, () => 's1');
    console.log('[Subprocess] badMacInterceptor installed');
  `, 2500);

  results.push({
    test: "badMacInterceptor.js Clean Exit",
    timedOut: interceptorImportRes.timedOut,
    stdout: interceptorImportRes.stdout.trim(),
    pass: interceptorImportRes.timedOut === false,
    note: interceptorImportRes.timedOut ? "Interceptor held event loop open!" : "Exited cleanly because _pruneTimer is unref'd"
  });

  // Test 3: Top-level side effects on import('./index.js')
  console.log("\n[Test 3] Dynamic import('./index.js') top-level bootup execution");
  const indexImportRes = await runNodeSubprocess(`
    console.log('[Subprocess] Importing index.js...');
    import('./index.js').then(() => {
      console.log('[Subprocess] index.js promise resolved');
    }).catch(err => {
      console.error('[Subprocess] index.js import rejected:', err);
    });
  `, 3000);

  results.push({
    test: "import('./index.js') Bootup",
    stdout: indexImportRes.stdout.trim(),
    stderr: indexImportRes.stderr.trim(),
    timedOut: indexImportRes.timedOut,
    pass: indexImportRes.stdout.includes("[Server]")
  });

  console.log("\n=== Test Results Summary ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
