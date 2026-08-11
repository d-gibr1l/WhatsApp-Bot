# Handoff Report — Explorer Survey 3: Query Timeouts & Global Process Error Boundaries

**Agent Folder**: `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_survey_3`  
**Date**: 2026-08-10  
**Target Focus**: Query Timeouts (`unexpected error in 'init queries'`), Global Process Error Boundaries (`uncaughtException`, `unhandledRejection`), and Process Crash Isolation.

---

## 1. Observation

Direct evidence collected from code inspection:

1. **`index.js:241–306`**:
   `sock.ev.on("connection.update", async (update) => { ... })` invokes asynchronous calls (`loadCache()`, `startCacheAutoRefresh()`, `loadWordFilter()`, `loadAllowedLinks()`, `loadAliases()`, `loadSeenMessages()`) without enclosing them in a `try...catch` block.
   - Verbatim snippet:
     ```javascript
     if (connection === "open") {
       ...
       await loadCache();
       startCacheAutoRefresh();
       await loadWordFilter();
       await loadAllowedLinks();
       await loadAliases();
       if (stopPoller) stopPoller();
       stopPoller = startReminderPoller(sock);
       startRadarEngine(sock);
       console.log("✅ Bot ready! Loading seen messages and waiting 3s for sync...");
       await loadSeenMessages();
       setTimeout(() => markBotReady(), 3000);
     }
     ```

2. **`index.js:133–135`**:
   `process.on("uncaughtException", ...)` logs the error but takes no corrective action, allowing broken process state to persist without process exit or socket teardown.
   - Verbatim snippet:
     ```javascript
     process.on("uncaughtException", (err) => {
       console.error("Uncaught Exception:", err.message, err.stack);
     });
     ```

3. **`src/auth/badMacInterceptor.js:202–207`**:
   `escalateRejection(reason)` checks `process.listenerCount('unhandledRejection') > 1`. If true, it returns immediately, quietly swallowing non-Signal unhandled rejections.
   - Verbatim snippet:
     ```javascript
     function escalateRejection(reason) {
       if (process.listenerCount('unhandledRejection') > 1) return;
       setImmediate(() => {
         throw reason;
       });
     }
     ```

4. **`src/auth/badMacInterceptor.js:308–356`**:
   `_unhandledHandler` only filters for `Bad MAC` and `MessageCounterError`. Any unhandled rejection from query timeouts (e.g. `unexpected error in 'init queries'` or `Query timed out`) is escalated via `setImmediate(() => { throw reason; })`, triggering process crash loops or container restarts on Koyeb/Docker.

---

## 2. Logic Chain

1. **Premise 1**: Baileys socket initialization issues query requests (`executeInitQueries`, app state sync, pre-keys). Under slow or unstable network conditions, these queries time out or reject with Boom errors (`unexpected error in 'init queries'`).
2. **Premise 2**: In Node.js, `EventEmitter` event listeners registered via `sock.ev.on(...)` do not await returned Promises. Any uncaught error inside `connection.update` or an un-handled query rejection surfaces on Node's `process` as an `unhandledRejection` event.
3. **Step 1**: In `index.js:241–306`, `loadCache()`, `loadWordFilter()`, `loadAllowedLinks()`, `loadAliases()`, and `loadSeenMessages()` are called sequentially inside `sock.ev.on("connection.update")` without `try...catch`. If Redis or DB experiences a transient failure, an `unhandledRejection` is emitted.
4. **Step 2**: In `badMacInterceptor.js:308–356`, `_unhandledHandler` receives this rejection. Because it is not a `Bad MAC` or `MessageCounterError`, `escalateRejection` re-throws it on the event loop via `setImmediate`.
5. **Step 3**: The re-thrown error hits `process.on("uncaughtException")` in `index.js:133`.
6. **Step 4**: `index.js` logs `Uncaught Exception: ...` but does NOT exit or reset `runBot()`. `runBot()`'s `shouldReconnect` Promise (lines 229–422) remains permanently pending, creating a zombie process where reconnect loops are permanently frozen.
7. **Step 5**: If another listener is registered for `unhandledRejection`, `process.listenerCount('unhandledRejection') > 1` causes `escalateRejection` to silently return without logging or throwing, hiding all non-Signal application failures.

---

## 3. Caveats

- **No Source Code Mutations**: This investigation was strictly read-only. No code changes were made to source files (`index.js` or `src/*`).
- **Network Mode**: Static analysis was performed in local environment without live WhatsApp Web socket traffic. Query timeout behavior was deduced from Baileys source paradigms and project configuration.

---

## 4. Conclusion

The WhatsApp bot's connection instability and container restart loops are driven by missing error boundaries around asynchronous post-connection setup hooks in `index.js`, unhandled Baileys query timeouts (`unexpected error in 'init queries'`) propagating through `badMacInterceptor.js`, and incomplete global process exception handling in `index.js`.

Addressing these 4 specific locations (`index.js:241-306`, `index.js:133-135`, `badMacInterceptor.js:68-76`, `badMacInterceptor.js:202-207`) will eliminate container restart loops and prevent hanging reconnect state.

---

## 5. Verification Method

1. **Static Analysis & Code Inspection**:
   - Inspect `index.js` lines 241–306 for missing `try...catch` around `loadCache`, `loadWordFilter`, `loadAllowedLinks`, `loadAliases`, `loadSeenMessages`.
   - Inspect `src/auth/badMacInterceptor.js` lines 202–207 for `listenerCount` check and lines 308–356 for `unhandledRejection` filtering.
2. **Linting Check**:
   - Run `npm run lint` from project root to ensure codebase complies with ESLint rules.
3. **Unit Tests Execution**:
   - Run `npm test` from project root to verify existing test suites run cleanly.
