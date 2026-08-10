# EMPIRICAL TEST REPORT: Bot Bootup & Error Resilience Stress Test

**Author**: Challenger 2 (Empirical Challenger)  
**Target Files**: `index.js`, `src/auth/badMacInterceptor.js`, `src/server.js`  
**Working Directory**: `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_challenger_auth_2`  
**Timestamp**: 2026-08-03T21:03:30Z

---

## 1. Observation

### 1.1 Bot Bootup Check Execution
- Command executed: `node -e "import('./index.js').catch(console.error)"`
- Results:
  - Process executes without synchronous syntax or top-level import errors.
  - Non-fatal environment warnings logged to `stderr`:
    ```
    ⚠️  SUPABASE_URL is not set — Supabase-backed features (settings, bans, admins) will be unavailable.
    ⚠️  SUPABASE_KEY is not set — Supabase-backed features (settings, bans, admins) will be unavailable.
    ```
  - Express server binds to port 3000 (`[Server] Attempting to bind to 0.0.0.0:3000...`).
  - Interceptor initialized (`[BadMAC] Interceptor installed — Bad MAC errors will be handled gracefully.`).
  - `runBot()` begins execution asynchronously with initial jitter (0-3000ms delay) and yt-dlp update check.

### 1.2 Unhandled Rejection Interceptor Vulnerabilities (`src/auth/badMacInterceptor.js`)

#### Finding 1: Primitive String Rejections Crash Process
- File & Line: `src/auth/badMacInterceptor.js:312`
- Code:
  ```javascript
  const msg = reason instanceof Error ? (reason.message ?? '') : '';
  ```
- Command & Output:
  ```bash
  node .agents/teamwork_preview_challenger_auth_2/test_unhandled_rejection.js
  ```
  Result:
  ```
  file:///C:/Users/domin/Desktop/my-whatsapp-bot-main/src/auth/badMacInterceptor.js:202
      throw reason;
      ^
  Bad MAC error string
  ```
  Process crashed with exit code `1`.

#### Finding 2: Console Error Interceptor Ignores String/Primitive Bad MAC Arguments
- File & Line: `src/auth/badMacInterceptor.js:275-279`
- Code:
  ```javascript
  let targetArg = args.find((a) => a instanceof Error);
  if (!targetArg) {
    targetArg = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
  }
  ```
- Empirical Verification: When `console.error("Session error:", "Bad MAC at async 44444.0 [as awaitable]")` is called with string parameters, `targetArg` evaluates to `undefined`. `extractKeyId(targetArg)` is bypassed and zero keys are purged (`Purged keys count: 0`).

#### Finding 3: Non-Error Purge Failure Logging
- File & Line: `src/auth/badMacInterceptor.js:350`
- Code: `_originalConsoleError('[BadMAC] Purge failed for ...', err.message);`
- Empirical Verification: If `purgeCorruptKey` throws a non-Error primitive (e.g., `throw "Redis connection failed"`), `err.message` evaluates to `undefined`, truncating error visibility.

### 1.3 Module Import Boundaries & Process Exit Behavior (`src/server.js`, `index.js`)

#### Finding 4: Top-Level Active Timers Prevent Event Loop Exit
- File & Line: `src/server.js:1351` & `1354`
- Code:
  ```javascript
  setInterval(broadcastStats, 1000);
  setInterval(() => { cleanupAntiDeleteStore().catch(...) }, 12 * 60 * 60 * 1000);
  ```
- Empirical Verification: Importing `src/server.js` or `index.js` starts active ref'd timers on the Node.js event loop. The process cannot terminate naturally without `process.exit()`.

#### Finding 5: Shutdown Dependency on Forced Exit
- File & Line: `index.js:62-92`
- Code: `shutdown(signal, exitCode)` closes socket and Redis WAL, followed by `process.exit(exitCode)`.
- Observation: `shutdown()` does not call `server.close()` or `clearInterval` for `broadcastStats`. The process relies entirely on `process.exit()` to terminate.

---

## 2. Logic Chain

1. **Bootup Behavior**: Executing `import('./index.js')` loads `config.js`, `src/server.js`, and `src/auth/badMacInterceptor.js` top-level side effects. `startServer()` immediately binds TCP port 3000 and starts `setInterval(broadcastStats, 1000)`. `runBot()` is launched asynchronously.
2. **Rejection Interceptor Flaw (String Rejections)**: In JavaScript Promises, rejections may yield non-Error primitives (e.g. `Promise.reject("Bad MAC...")`). Line 312 of `badMacInterceptor.js` guards message extraction with `reason instanceof Error`. For string rejections, `msg` evaluates to `''`, causing `isBadMac` to evaluate to `false`. The interceptor misidentifies it as an unrelated rejection and invokes `escalateRejection(reason)`, which re-throws via `setImmediate`, crashing the process.
3. **Key Extraction Flaw (Log Interceptor)**: Baileys logs decryption errors via `console.error`. Line 275 of `badMacInterceptor.js` filters `args` using `a instanceof Error` or `typeof a === 'object'`. String arguments containing Signal address trace strings are ignored, resulting in `keyInfo = null` and zero key purges.
4. **Exit & Lifecycle Boundaries**: `src/server.js` registers un-unref'd intervals at top-level scope upon import. Any import of `src/server.js` or `index.js` keeps the Node event loop alive indefinitely. `shutdown()` in `index.js` correctly issues `process.exit()` to ensure process termination.

---

## 3. Caveats

- Tests were performed in a standalone Node.js environment without active WhatsApp WebSocket connections or live Redis/MongoDB databases.
- Network interactions during `fetchLatestBaileysVersion()` and `updateYtDlp()` were mocked/observed under current sandbox conditions.

---

## 4. Conclusion

- **Bot Bootup**: Pass. `node -e "import('./index.js').catch(console.error)"` executes cleanly without synchronous initialization failures.
- **Error Resilience (`badMacInterceptor.js`)**: **Vulnerable**.
  - **High Risk**: String-based unhandled rejections containing `'Bad MAC'` crash the process due to `reason instanceof Error` check.
  - **Medium Risk**: Log interceptor misses Bad MAC key extraction when errors are logged as string parameters.
  - **Pass**: Circuit breaker (3 bad MACs in 60s triggering JID key wipe) and concurrent in-flight deduplication function correctly.
- **Import & Process Exit Boundaries**: Pass with design notes. Import side-effects (Express listener + `setInterval`) mean `index.js` is a dedicated main entry point and relies on `process.exit()` during shutdown.

---

## 5. Verification Method

To independently verify these findings, execute the provided test scripts:

1. **Verify Bootup Check**:
   ```bash
   node -e "import('./index.js').catch(console.error)"
   ```
2. **Verify Bad MAC Interceptor Rejection Vulnerabilities**:
   ```bash
   node .agents/teamwork_preview_challenger_auth_2/test_unhandled_rejection_advanced.js
   ```
   *Invalidation condition*: If primitive string rejections (`Promise.reject("Bad MAC...")`) are handled without calling `escalateRejection` or crashing, Finding 1 is invalidated.
3. **Verify Import Event Loop Persistence**:
   ```bash
   node .agents/teamwork_preview_challenger_auth_2/test_import_and_exit.js
   ```
