# Comprehensive Technical Analysis: Query Timeouts and Global Process Error Boundaries

**Agent**: Survey Explorer 3  
**Target Area**: Baileys Query Timeouts (`unexpected error in 'init queries'`), Socket Connection Listeners, Global Process Error Boundaries (`uncaughtException`, `unhandledRejection`), and Process Crash Boundaries.  
**Repository Root**: `C:\Users\domin\Desktop\my-whatsapp-bot-main`  
**Date**: 2026-08-10  

---

## 1. Executive Summary

This investigation analyzed the connection lifecycle, socket event handling, query execution routines, and process-level error handlers in the Baileys WhatsApp bot. 

Key architectural vulnerabilities were identified that directly cause:
1. **Container Restarts & Process Crashes**: Unhandled Promise rejections from Baileys query timeouts (`unexpected error in 'init queries'`) and post-connect async setup hooks escaping into Node's event loop via lossy escalation.
2. **Zombie Process & Stalled Reconnect Loops**: Inadequate `uncaughtException` handling in `index.js` that logs errors without gracefully exiting or initiating socket cleanup, leaving `runBot()` stuck in pending Promise states.
3. **Silent Error Suppression**: Flawed listener count checks (`process.listenerCount('unhandledRejection') > 1`) in `badMacInterceptor.js` that swallow critical non-Signal application rejections whenever duplicate listeners exist.
4. **Unhandled Async Rejections in Connection Listeners**: Post-connection initialization routines (`loadCache`, `loadWordFilter`, `loadAllowedLinks`, `loadAliases`, `loadSeenMessages`) called inside `sock.ev.on("connection.update")` without `try...catch` boundaries, causing unhandled rejections that bypass EventEmitter.

---

## 2. Detailed Findings & Failure Pathways

### Finding 1: Unhandled Async Rejections in `connection.update` Listener (`index.js`)

- **Location**: `index.js`, Lines 241–306
- **Function**: `runBot()` / `sock.ev.on("connection.update", async (update) => ...)`
- **Severity**: **CRITICAL**

#### Mechanism & Code Analysis
In `index.js`, when `connection === "open"`, the bot runs an `async` arrow function attached to `sock.ev.on("connection.update")`. This callback invokes several asynchronous cache loading and initialization tasks:

```javascript
// index.js:277-303
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
```

None of these `await` calls are enclosed within a `try...catch` block (unlike `getAdmins`). 

#### Failure Pathway
1. In Node.js, `EventEmitter` calls event listeners synchronously and **does not await or attach `.catch()` to Promises returned by `async` event handlers**.
2. If Redis or MongoDB experiences a transient network glitch during `loadCache()`, `loadWordFilter()`, or `loadSeenMessages()`, the Promise returned by the `connection.update` callback rejects.
3. Node.js emits an `unhandledRejection` event on `process`.
4. `badMacInterceptor.js` receives the unhandled rejection. Since the error is not a Signal decryption error (`Bad MAC` or `MessageCounterError`), it passes through to `escalateRejection(reason)`.
5. `escalateRejection(reason)` re-throws the error on the next tick via `setImmediate(() => { throw reason; })`.
6. The error lands in `process.on("uncaughtException")` in `index.js:133`.
7. `uncaughtException` logs the error, but `runBot()`'s `shouldReconnect` Promise (lines 229–422) **never resolves or rejects**.
8. **Result**: The bot remains in a broken, half-initialized state (`botReady` may be set, but caches/reminders are uninitialized), and `runBot()` hangs indefinitely, unable to process future reconnect attempts if the connection drops.

---

### Finding 2: Baileys Query Timeouts (`unexpected error in 'init queries'`) Escaping as Unhandled Rejection

- **Location**: `index.js`, Lines 149–165 & 307–415; `@whiskeysockets/baileys`
- **Function**: `createSocket()` / `makeWASocket()` & Disconnect Handler
- **Severity**: **HIGH**

#### Mechanism & Code Analysis
When Baileys establishes a WebSocket connection, it sends initialization queries (`executeInitQueries`, fetching app state, pre-keys, passive connection parameters). Baileys applies a query timeout configured by `defaultQueryTimeoutMs: 60_000` (`index.js:159`).

If the WhatsApp server fails to respond within 60 seconds (or returns a corrupt stanza):
1. Baileys rejects internal query promises with a Boom error: `Boom: unexpected error in 'init queries'` or `Boom: Query timed out`.
2. Baileys emits a `connection.update` event with `{ connection: "close", lastDisconnect: { error: Boom } }`.
3. In `index.js`, the disconnect handler inspects `lastDisconnect?.error?.output?.statusCode`.
4. However, query timeouts often produce status code `500` (Internal Server Error) or `undefined`.
5. When `statusCode` is `undefined`, `index.js` categorizes it as an `Unknown disconnect (undefined)` (line 412) and calls `safeResolve(true)`.
6. **The Hazard**: If Baileys emits the unhandled query rejection prior to emitting `connection: "close"`, or if an internal query promise escapes Baileys' internal catch block, Node emits `unhandledRejection`.
7. Because `badMacInterceptor.js` only suppresses `Bad MAC`, `MessageCounterError`, and `Key used already`, `unexpected error in 'init queries'` is logged as an unhandled rejection and escalated via `setImmediate`, causing process crash loops or container restarts on Koyeb/Docker.

---

### Finding 3: Lossy & Dangerous Rejection Escalation in `badMacInterceptor.js`

- **Location**: `src/auth/badMacInterceptor.js`, Lines 202–207 & 308–356
- **Function**: `escalateRejection(reason)` / `_unhandledHandler(reason)`
- **Severity**: **HIGH**

#### Mechanism & Code Analysis
In `badMacInterceptor.js`:

```javascript
// badMacInterceptor.js:202-207
function escalateRejection(reason) {
  if (process.listenerCount('unhandledRejection') > 1) return;
  setImmediate(() => {
    throw reason;
  });
}
```

#### Failure Pathway
1. `_unhandledHandler` intercepts all `unhandledRejection` events on `process`.
2. If the rejection is NOT a Bad MAC or MessageCounterError, it logs the rejection and calls `escalateRejection(reason)`.
3. `escalateRejection` checks `process.listenerCount('unhandledRejection') > 1`.
4. If any other component, library, or script (such as Express, Supabase, or test runners) registers a second listener for `unhandledRejection`, `process.listenerCount('unhandledRejection')` is `>= 2`.
5. In this case, `escalateRejection` **immediately returns without throwing**.
6. **Result**: All genuine application rejections (e.g. database network errors, unhandled HTTP failures, file I/O errors) are **completely swallowed without trace**, hiding critical bugs and leaving the application in a silent failing state.

---

### Finding 4: Insufficient Global `uncaughtException` Handler Creating Zombie Processes

- **Location**: `index.js`, Lines 133–135
- **Function**: `process.on("uncaughtException", ...)`
- **Severity**: **HIGH**

#### Mechanism & Code Analysis
In `index.js`:

```javascript
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message, err.stack);
});
```

#### Failure Pathway
1. In Node.js, the default behavior for an uncaught exception is to print the stack trace and terminate the process with non-zero status, allowing process managers (Koyeb, Docker, PM2, systemd) to restart the container cleanly.
2. `index.js` intercepts `uncaughtException` and **only logs the error to console**, allowing execution to continue.
3. When an uncaught exception occurs (e.g., from `setImmediate` in `badMacInterceptor.js` or an unhandled callback error), the Node.js event loop continues running, but essential state or event handlers may be broken or corrupted.
4. The HTTP server (`src/server.js`) remains running and reports healthy status (`/health`), but the WhatsApp socket or internal poller is dead. Container orchestrators will never auto-heal or restart the dead bot instance.

---

### Finding 5: Missing Error Boundaries in Peripheral Initialization Services (`radar.js` and `cache.js`)

- **Location**: `src/commands/radar.js` (Lines 171–191) & `src/cache.js` (Lines 157–197)
- **Functions**: `startRadarEngine(sock)` and `startCacheAutoRefresh()`
- **Severity**: **MEDIUM**

#### Mechanism & Code Analysis
1. `startRadarEngine(sock)` is called on every reconnect in `index.js:284` and `index.js:300`.
2. Inside `startRadarEngine`:
   ```javascript
   getRadars().then(radars => {
     const animeIds = [...new Set(radars.filter(r => r.type === "anime").map(r => r.target))];
     for (const id of animeIds) {
       scheduleAnime(parseInt(id), sock);
     }
   }).catch(err => console.error("[Radar] Engine init error:", err));
   ```
   While `getRadars()` has a `.catch()`, inside `scheduleAnime`:
   ```javascript
   const timer = setTimeout(async () => {
     activeAnimeTimers.delete(animeId);
     await notifyAnime(anime, sock);
     setTimeout(() => scheduleAnime(animeId, sock), 5 * 60 * 1000);
   }, msUntilAiring);
   ```
   The `setTimeout` callback is an `async () => { ... }`. If an exception occurs outside `notifyAnime`'s internal try/catch or inside `scheduleAnime`'s timer setup, the rejected promise from the async timer callback is unhandled and surfaces as an `unhandledRejection`.

3. In `src/cache.js`, `startCacheAutoRefresh()` subscribes to Supabase Realtime changes (`supabase.channel(...)`). If the Supabase client throws synchronously or rejects inside the status callback without a catch block, it can leak unhandled rejections into the main process.

---

## 3. Recommended Remediation & Action Plan

### Recommendation 1: Wrap `connection === "open"` Post-Connect Setup in Try/Catch
In `index.js`, wrap the post-connection initialization logic inside a robust `try...catch` block:

```javascript
if (connection === "open") {
  setConnected();
  lastConnectedAt = Date.now();
  attempt = 1;

  if (sock.user?.id) {
    const detectedNumber = sock.user.id.split(":")[0].split("@")[0];
    botConfig.BOT_NUMBER = detectedNumber;
    console.log(`Connected as: ${detectedNumber}`);
  }

  try {
    if (!botReady) {
      botReady = true;
      try {
        const { getAdmins, addAdmin } = await import("./src/db.js");
        const admins = await getAdmins();
        if (admins.length === 0 && botConfig.BOT_NUMBER) {
          await addAdmin(botConfig.BOT_NUMBER);
          console.log(`Auto-added ${botConfig.BOT_NUMBER} as super admin`);
        }
      } catch (err) {
        console.error("Auto-admin setup failed:", err.message);
      }

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
    } else {
      await loadCache();
      await loadWordFilter();
      await loadAllowedLinks();
      await loadAliases();
      if (stopPoller) stopPoller();
      stopPoller = startReminderPoller(sock);
      startRadarEngine(sock);
      console.log("🔄 Reconnected — caches refreshed. Waiting 3s for sync...");
      await loadSeenMessages();
      setTimeout(() => markBotReady(), 3000);
    }
  } catch (err) {
    console.error("⚠️ Error during post-connection initialization:", err.message);
    // Non-fatal cache/poller errors should not crash the socket, but must be logged safely
  }
}
```

### Recommendation 2: Handle `unexpected error in 'init queries'` and Connection Timeouts Gracefully
Update `badMacInterceptor.js` to recognize query timeout errors (such as `unexpected error in 'init queries'`, `Query timed out`, or `timed out`) and handle them cleanly without escalating to `uncaughtException`:

```javascript
// In badMacInterceptor.js
const SUPPRESS_PATTERNS = [
  'Bad MAC',
  'Key used already',
  'MessageCounterError',
  'Failed to decrypt message',
  'Session error:',
  'Closing session: SessionEntry',
  'Closing open session in favor of incoming prekey bundle',
  'unexpected error in \'init queries\'',
  'Query timed out',
  'timed out',
];
```

In addition, update `_unhandledHandler` in `badMacInterceptor.js` to catch query timeouts and log them gracefully as recoverable socket warnings rather than throwing unhandled exceptions.

### Recommendation 3: Fix Rejection Escalation in `badMacInterceptor.js`
Remove the flawed `if (process.listenerCount('unhandledRejection') > 1) return;` check so that non-Signal rejections are consistently logged and handled.

### Recommendation 4: Implement Graceful Process Termination on Uncaught Exception
Update `process.on("uncaughtException")` in `index.js` to initiate a clean shutdown:

```javascript
process.on("uncaughtException", async (err) => {
  console.error("Fatal Uncaught Exception:", err.message, err.stack);
  await shutdown("UNCAUGHT_EXCEPTION", 1);
});
```

---

## 4. Verification Method

To verify these findings independently:
1. **Static Inspection**: Inspect `index.js` lines 241–306 and `src/auth/badMacInterceptor.js` lines 202–207 and 308–356 using `view_file`.
2. **Lint Verification**: Run `npm run lint` from project root to ensure lint compliance.
3. **Unit Tests**: Run `npm test` to verify existing auth and cache test suites pass without regression.
