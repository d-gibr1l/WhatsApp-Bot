# Handoff Report — Baileys Disconnect Instability & Session Error Fixes

**Agent**: Survey Explorer 2  
**Role**: Teamwork Explorer (Read-only investigation)  
**Target Directory**: `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_survey_2`  
**Timestamp**: 2026-08-10T20:38:15Z  

---

## 1. Observation

Direct observations from source files in `C:\Users\domin\Desktop\my-whatsapp-bot-main`:

1. **`src/auth/badMacInterceptor.js` (lines 308–325, 202–207)**:
   ```javascript
   // Line 318-322:
   if (!isCounter && !isBadMac) {
     _originalConsoleError('Unhandled Rejection:', reason);
     escalateRejection(reason);
     return;
   }

   // Line 202-207:
   function escalateRejection(reason) {
     if (process.listenerCount('unhandledRejection') > 1) return;
     setImmediate(() => {
       throw reason;
     });
   }
   ```
   The `unhandledRejection` listener explicitly re-throws any promise rejection that is not `MessageCounterError` or `Bad MAC` by calling `setImmediate(() => { throw reason; })`.

2. **`index.js` (lines 310–321, 401–407, 381–390)**:
   ```javascript
   // Line 310-313:
   const statusCode =
     lastDisconnect?.error instanceof Boom
       ? lastDisconnect.error.output.statusCode
       : lastDisconnect?.error?.output?.statusCode;

   // Line 401-407:
   if (statusCode === 408 && lastConnectedAt === 0) {
     attempt = Math.max(attempt - 1, 1);
     return safeResolve(true);
   }

   // Line 384-389:
   if (statusCode === DisconnectReason.connectionClosed) {
     if (Date.now() - lastConnectedAt > 30_000) {
       console.log("Stable connection lost (428) — resetting attempt counter.");
       attempt = 1;
     }
     return safeResolve(true);
   }
   ```
   - Standard `Error` instances without `error.output.statusCode` result in `statusCode` being `undefined`.
   - Status 408 (Connection Lost) on established connections (`lastConnectedAt > 0`) falls through to line 409 (`Unknown disconnect`), incrementing `attempt`.
   - Status 428 (Connection Closed) does not reset `attempt` if the socket was connected for under 30 seconds.

3. **`index.js` (lines 220–224, 437)**:
   ```javascript
   // Line 220-224 (executed ONLY at top of loop on next attempt, AFTER backoff sleep):
   if (currentSock) {
     try { currentSock.ev.removeAllListeners(); } catch {}
     try { currentSock.ws?.close(); } catch {}
     currentSock = null;
   }

   // Line 437:
   await new Promise(r => setTimeout(r, delay));
   ```
   Socket cleanup (`currentSock.ws?.close()`) and listener detachment (`currentSock.ev.removeAllListeners()`) occur *after* the backoff sleep delay (up to 60 seconds) rather than immediately upon socket closure. `currentSock.ws?.terminate()` is never called.

4. **`src/handler.js` (lines 110–138, 142–151)**:
   ```javascript
   // Line 142-151:
   let connectedAt = Infinity;

   export function markBotReady() {
     connectedAt = Date.now();
   }

   export function isBotReady() {
     return connectedAt !== Infinity;
   }
   ```
   `connectedAt` is never reset to `Infinity` when the socket disconnects. `isBotReady()` remains `true` continuously during disconnection and reconnection.

5. **`src/commands/radar.js` (lines 171–191)** & **`src/handler.js` (lines 110–138)**:
   Background timers (`startReminderPoller` and `startRadarEngine`) are not cancelled when `connection === "close"` fires. They continue executing read/write calls against closed sockets.

---

## 2. Logic Chain

1. **Rejection Escalation to Process Crash**:
   - Observation 1 shows `badMacInterceptor.js` filtering unhandled rejections using `if (!isCounter && !isBadMac)`.
   - When Baileys experiences a 408 or 428 socket disconnect while background queries or handshakes are in progress, internal promise rejections such as `Boom: Connection Lost`, `Boom: Connection Closed`, `unexpected error in 'init queries'`, or `SessionError: No session record` are emitted.
   - None of these match `isCounter` or `isBadMac`.
   - Therefore, `badMacInterceptor.js` logs the rejection and executes `setImmediate(() => { throw reason; })`.
   - This turns recoverable background promise rejections into uncaught exceptions, causing Node.js to crash and container managers (Koyeb/Docker) to restart the container.

2. **Exponential Reconnect Loop Exhaustion**:
   - Observation 2 shows `statusCode` extraction looking only for `lastDisconnect.error.output.statusCode`. Non-Boom errors evaluate to `undefined`.
   - When a 408 (Connection Lost / Timed Out) occurs on a connected bot (`lastConnectedAt > 0`), `lastConnectedAt === 0` is false, causing 408 to fall through to line 409 and increment `attempt`.
   - When a 428 (Connection Closed) occurs within 29 seconds of connecting, `attempt` is not reset, and `attempt` is incremented.
   - Repeated 408/428 disconnects accumulate `attempt` until it exceeds `MAX_RECONNECTS` (line 428), invoking `shutdown("MAX_RECONNECTS", 1)` and killing the process.

3. **Socket and Memory Leak Mechanism**:
   - Observation 3 shows socket closure (`currentSock.ws?.close()`) occurring only at line 220, after `await new Promise(r => setTimeout(r, delay))` (up to 60 seconds).
   - During the sleep delay, the dead socket handle remains in memory. `.close()` does not forcefully terminate dead TCP sockets (`.terminate()`), leaving open socket descriptors.
   - Observations 4 and 5 show that `connectedAt` is never reset upon socket close, and background pollers (`reminderPoller`, `radarEngine`) continue firing during the backoff period.
   - When WhatsApp flushes historical offline messages (`messages.upsert`) upon reconnecting, `bindMessagesEvents` checks `if (!isBotReady())`. Because `connectedAt !== Infinity`, `isBotReady()` is `true`, causing the bot to process stale historical messages as live commands.

---

## 3. Caveats

- **Network-level simulated packet drop tests**: Full empirical validation of WebSocket TCP teardown requires running live Baileys connections or mock WebSocket servers with packet drop simulation.
- **Scope Restriction**: In accordance with the Explorer persona, no code modifications were made to files in `src/` or `index.js`. All findings are documented in `analysis.md` and this handoff report.

---

## 4. Conclusion

The WhatsApp bot connection instability, 408/428 disconnect crashes, and container restarts are driven by 5 root causes:
1. **Rejection Escalation**: `badMacInterceptor.js` re-throws all non-BadMAC/Counter rejections via `setImmediate`, converting 408/428 query timeouts and `SessionError` into uncaught process crashes.
2. **Disconnect Code Misclassification**: Non-Boom error objects resolve to `undefined` status codes; 408 disconnects on active sessions increment `attempt`; 428 disconnects under 30s burn reconnect attempts.
3. **Delayed & Incomplete Socket Cleanup**: Socket close and listener cleanup occur after backoff sleep rather than immediately upon socket close; `.terminate()` is missing.
4. **Timer Leaks**: Reminder poller, RSS poller, and anime timers continue running on closed sockets.
5. **Stale Ready State**: `connectedAt` is never reset to `Infinity` on disconnect, allowing historical offline messages flushed upon reconnect to execute as commands.

---

## 5. Verification Method

To independently verify these findings:

1. **Verify Unhandled Rejection Escalation**:
   Inspect `src/auth/badMacInterceptor.js` lines 308–325 and lines 202–207. Confirm that `if (!isCounter && !isBadMac)` leads to `escalateRejection(reason)`, which executes `setImmediate(() => { throw reason; })`.
2. **Verify Disconnect Code Logic**:
   Inspect `index.js` lines 310–321, 381–390, and 401–407. Confirm that:
   - `statusCode` extraction relies on `lastDisconnect?.error?.output?.statusCode`.
   - Line 404 checks `lastConnectedAt === 0` for status 408.
   - Line 385 checks `Date.now() - lastConnectedAt > 30_000` for status 428.
3. **Verify Socket Cleanup Delay**:
   Inspect `index.js` lines 220–224 and line 437. Confirm that socket cleanup occurs inside `while` loop BEFORE `createSocket()` but AFTER `await new Promise(r => setTimeout(r, delay))`.
4. **Verify Ready State Leak**:
   Inspect `src/handler.js` lines 142–151 and `src/events/messages.js` lines 44–50. Confirm there is no `resetBotReady()` function resetting `connectedAt = Infinity` when `connection === "close"` fires.
5. **Run Existing Test Suite**:
   Execute `node --test tests/*.test.js` to ensure baseline test suite passes.
