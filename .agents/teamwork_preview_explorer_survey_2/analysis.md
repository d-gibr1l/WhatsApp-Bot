# Technical Analysis: Baileys Disconnect Handling, Status Codes, Socket Cleanup, and Reconnection Loops

**Agent**: Survey Explorer 2  
**Target Module**: Baileys Disconnect Handling, Status Code Processing (408/428), Socket Lifecycle, Event Listeners, Timer Leaks, and Reconnect Loops  
**Workspace Root**: `C:\Users\domin\Desktop\my-whatsapp-bot-main`  
**Working Directory**: `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_survey_2`  
**Timestamp**: 2026-08-10T20:38:00Z  

---

## Executive Summary

This report presents an exhaustive investigation into the connection instability, socket disconnect handling, uncaught exceptions, memory leaks, and reconnection loops within the WhatsApp bot codebase. 

Key findings reveal 5 major architectural defects in connection management:
1. **Unhandled Rejection Escalation**: `badMacInterceptor.js` intercepts `unhandledRejection` events but re-throws any rejection that is not strictly a `MessageCounterError` or `Bad MAC` error using `setImmediate(() => { throw reason; })`. This converts recoverable Baileys query timeouts (e.g., `unexpected error in 'init queries'`), session errors (`SessionError: No session record`), and 408/428 network drops into uncaught process exceptions that crash Node.js and trigger container restarts.
2. **Flawed Disconnect Code Processing**: Disconnect status extraction in `index.js` fails for non-Boom errors. Furthermore, Status Code 408 (Connection Lost / Timed Out) increments `attempt` on established connections (`lastConnectedAt > 0`), causing temporary network blips to reach `MAX_RECONNECTS` and terminate the bot. Status Code 428 (Connection Closed) only resets `attempt` if the socket was connected for >30 seconds.
3. **Incomplete Socket Cleanup**: Socket closure (`sock.ws?.close()`) and listener detachment (`sock.ev.removeAllListeners()`) occur at the *start* of the next reconnect attempt rather than *immediately* upon socket disconnection. `sock.ws?.terminate()` is never called, leaving dangling TCP sockets and event listeners in memory during exponential backoff delays (up to 60 seconds).
4. **Timer and Interval Leaks on Disconnected Sockets**: Active background pollers (`startReminderPoller` in `src/handler.js` and `startRadarEngine` in `src/commands/radar.js`) are not stopped when `connection === "close"` occurs. They continue firing every 30 seconds / 10 minutes against dead socket handles, causing secondary error cascades. Additionally, `markBotReady()` uses un-tracked 3-second `setTimeout` calls that fire after socket disconnects.
5. **Stale Ready State & Reconnect Command Execution**: `connectedAt` in `src/handler.js` is never reset to `Infinity` upon socket closure. As a result, `isBotReady()` remains `true` during disconnects and reconnections, causing historical offline messages flushed by WhatsApp upon reconnect to bypass the `!isBotReady()` check and execute as live commands.

---

## Detailed Findings

### Finding 1: Unhandled Rejection Escalation Causing Container Restarts

* **Location**: `src/auth/badMacInterceptor.js` (lines 308–355, 202–207), `index.js` (lines 133–135)
* **Function**: `_unhandledHandler`, `escalateRejection`
* **Mechanism**:
  - `badMacInterceptor.js` installs a global `unhandledRejection` process listener (line 356).
  - Inside `_unhandledHandler`, line 318 filters rejections:
    ```javascript
    if (!isCounter && !isBadMac) {
      _originalConsoleError('Unhandled Rejection:', reason);
      escalateRejection(reason);
      return;
    }
    ```
  - `escalateRejection` (lines 202–207) re-throws the rejection:
    ```javascript
    function escalateRejection(reason) {
      if (process.listenerCount('unhandledRejection') > 1) return;
      setImmediate(() => {
        throw reason;
      });
    }
    ```
  - When Baileys experiences a network disconnect (408 / 428) or session lookup failure, background internal promises reject with errors like:
    - `Boom: Connection Lost` (408)
    - `Boom: Connection Closed` (428)
    - `unexpected error in 'init queries'`
    - `SessionError: No session record`
    - `SessionError: No matching sessions found for message`
  - None of these strings contain `Bad MAC` or `MessageCounterError`. Consequently, `badMacInterceptor.js` logs `Unhandled Rejection:` and executes `setImmediate(() => { throw reason; })`.
  - Throwing inside `setImmediate` turns background rejections into uncaught exceptions, triggering Node's `uncaughtException` event and crashing containerized deployments (Koyeb / Docker / Render).

* **Impact**: Critical — background network drops or session decryption misses crash the entire bot process instead of gracefully reconnecting.

---

### Finding 2: Status Code Extraction Faults and Reconnect Attempt Accumulation

* **Location**: `index.js` (lines 310–321, 381–414)
* **Function**: `runBot()` -> `connection.update` handler
* **Mechanism**:
  - **Non-Boom Status Code Extraction**:
    ```javascript
    const statusCode =
      lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : lastDisconnect?.error?.output?.statusCode;
    ```
    If `lastDisconnect.error` is a standard JavaScript `Error` (or a network socket error like `ECONNRESET`), `lastDisconnect?.error?.output?.statusCode` evaluates to `undefined`. `statusCode` becomes `undefined`, causing 408 or 428 disconnects to fall through to line 409 (`Unknown disconnect (undefined) — reconnecting with backoff.`).
  - **408 Connection Lost / Timed Out**:
    ```javascript
    if (statusCode === 408 && lastConnectedAt === 0) {
      attempt = Math.max(attempt - 1, 1);
      return safeResolve(true);
    }
    ```
    If 408 occurs after the bot has already connected (`lastConnectedAt > 0`), `lastConnectedAt === 0` is `false`. The disconnect falls through to the unknown disconnect handler, incrementing `attempt`. Repeated 408 timeouts during unstable WiFi/cellular connections reach `MAX_RECONNECTS` (line 428), invoking `shutdown("MAX_RECONNECTS", 1)` and terminating the process.
  - **428 Connection Closed Threshold**:
    ```javascript
    if (statusCode === DisconnectReason.connectionClosed) {
      if (Date.now() - lastConnectedAt > 30_000) {
        console.log("Stable connection lost (428) — resetting attempt counter.");
        attempt = 1;
      }
      return safeResolve(true);
    }
    ```
    If a 428 disconnect occurs within 29 seconds of connecting (e.g. initial handshake instability), `attempt` is NOT reset, causing `attempt` to accumulate and trigger process shutdown after multiple quick network drops.

* **Impact**: High — transient network blips and 408/428 disconnects cause progressive attempt accumulation that eventually kills the bot.

---

### Finding 3: Incomplete Socket Cleanup and Event Listener Retention

* **Location**: `index.js` (lines 97–101, 220–224), `src/events/messages.js`, `src/events/groups.js`, `src/events/calls.js`
* **Function**: `runBot()`, `createSocket()`, `bindMessagesEvents()`, `bindGroupEvents()`, `bindCallEvents()`
* **Mechanism**:
  - **Delayed Teardown**: When `connection === "close"` is received, `currentSock` is NOT cleaned up immediately. `connection.update` resolves `shouldReconnect`, which causes `runBot()` to sleep for the backoff duration (line 437: `await new Promise(r => setTimeout(r, delay))`), sleeping up to 60 seconds.
  - Socket cleanup only happens at the top of the next loop iteration (line 220):
    ```javascript
    if (currentSock) {
      try { currentSock.ev.removeAllListeners(); } catch {}
      try { currentSock.ws?.close(); } catch {}
      currentSock = null;
    }
    ```
  - **Incomplete Termination**: `currentSock.ws?.close()` sends a WebSocket close frame. If the socket experienced a hard network failure (408 / TCP reset), `.close()` hangs or fails quietly without destroying the TCP connection. `currentSock.ws?.terminate()` is never called, leaving socket handles open in the Node process during backoff sleeps.
  - **EventListener Leak**: `sock.ev.removeAllListeners()` strips listeners on Baileys' `ev` bus, but internal WebSocket event listeners on `sock.ws` remain attached, preventing garbage collection of old socket instances during rapid reconnection cycles.

* **Impact**: High — socket and memory leaks during repeated reconnection attempts.

---

### Finding 4: Active Timers and Interval Leaks on Disconnected Sockets

* **Location**: `src/handler.js` (lines 110–138), `src/commands/radar.js` (lines 171–191), `index.js` (lines 283, 298, 289, 303)
* **Function**: `startReminderPoller()`, `startRadarEngine()`, `markBotReady()`
* **Mechanism**:
  - **Reminder Poller**: `startReminderPoller(sock)` starts a 30-second `setInterval`. On non-fatal socket disconnects (408, 428, 500, 515), `stopPoller()` is NEVER called. The poller continues executing every 30 seconds during disconnection, calling `sock.sendMessage()` on the closed socket. This throws errors, which invoke `alertOwner(sock, ...)`, attempting to send owner alerts on the same dead socket.
  - **Radar Engine**: `startRadarEngine(sock)` creates `rssPollerInterval` (10-minute interval) and populates `activeAnimeTimers`. On socket disconnect, these intervals/timers are not cleared. They fire during disconnects, trying to send messages via dead sockets.
  - **Untracked 3s Sync Timer**: `index.js` executes `setTimeout(() => markBotReady(), 3000)` without saving the timer reference. If the socket closes within 3 seconds of connecting, `markBotReady()` executes anyway on a disconnected socket.

* **Impact**: Medium-High — background pollers spam dead sockets with write requests during disconnects, polluting logs and causing unhandled exceptions.

---

### Finding 5: Stale Bot Ready State and Reconnection Command Execution Race Conditions

* **Location**: `src/handler.js` (lines 142–151), `index.js` (lines 277–304), `src/events/messages.js` (lines 44–50)
* **Function**: `markBotReady()`, `isBotReady()`, `bindMessagesEvents()`
* **Mechanism**:
  - `src/handler.js` tracks readiness via `let connectedAt = Infinity;`.
  - `markBotReady()` sets `connectedAt = Date.now()`. `isBotReady()` returns `connectedAt !== Infinity`.
  - When a socket disconnects (`connection === "close"`), `connectedAt` is NEVER reset back to `Infinity`.
  - Consequently, `isBotReady()` remains `true` continuously during disconnection and during the initial 3-second sync phase after reconnecting.
  - When WhatsApp flushes historical offline messages (`messages.upsert`) immediately after reconnecting, `bindMessagesEvents` checks:
    ```javascript
    if (!isBotReady()) {
      for (const msg of messages) {
        const id = msg?.key?.id;
        if (id) rememberMessage(id);
      }
      return;
    }
    ```
  - Because `isBotReady()` is `true`, historical messages pass through and get enqueued for execution by `chatQueue.enqueue()`, causing the bot to reply to old command messages sent while the bot was offline.

* **Impact**: High — bot re-executes historical commands upon reconnecting, causing unwanted duplicate actions.

---

## Actionable Recommendations & Proposed Code Changes

### 1. Update `src/auth/badMacInterceptor.js`
- **Change**: Expand `isSuppressible` and `_unhandledHandler` to suppress Baileys query timeouts (`unexpected error in 'init queries'`), connection lost/closed Boom errors, and `SessionError` variants (`No session record`, `No matching sessions found for message`).
- **Remove/Refactor `escalateRejection`**: Prevent converting unhandled promise rejections into uncaught exceptions via `setImmediate(() => { throw reason; })`. Instead, log the suppressed rejection safely and return.

### 2. Update `index.js` Disconnect & Status Code Handling
- **Robust Status Code Extraction**: Support raw `Error` objects, `error.statusCode`, `error.code`, and `error.output.statusCode`.
- **408 & 428 Handling**:
  - For 408 (Connection Lost / Timed Out), reset or cap `attempt` to prevent burning through `MAX_RECONNECTS` during transient network drops.
  - For 428 (Connection Closed), reset `attempt = 1` whenever the socket closed cleanly, regardless of whether it ran for >30s or <30s.
- **Immediate Socket & Listener Teardown**:
  - When `connection === "close"` is received, immediately call `currentSock?.ev?.removeAllListeners()`, `currentSock?.ws?.close()`, and `currentSock?.ws?.terminate()`.
  - Immediately stop background timers (`stopPoller()`, clear radar timers, and reset bot ready state).

### 3. Reset Bot Ready State in `src/handler.js`
- Export `resetBotReady()` from `src/handler.js`:
  ```javascript
  export function resetBotReady() {
    connectedAt = Infinity;
  }
  ```
- Call `resetBotReady()` in `index.js` whenever `connection === "close"` occurs.
- Ensure that `setTimeout(() => markBotReady(), 3000)` handles are stored and cancelled if the socket disconnects before the 3 seconds elapse.

### 4. Cleanup Radar & Poller Engine on Disconnect
- Export `stopRadarEngine()` from `src/commands/radar.js` to clear `rssPollerInterval` and all `activeAnimeTimers`.
- Invoke `stopRadarEngine()` and `stopPoller()` immediately upon socket disconnect.

---

## File and Line Reference Table

| Component | File Path | Line Numbers | Affected Function / Feature | Issue Category |
|-----------|-----------|--------------|-----------------------------|----------------|
| Interceptor | `src/auth/badMacInterceptor.js` | 308–355, 202–207 | `_unhandledHandler`, `escalateRejection` | Uncaught Exceptions & Process Restarts |
| Reconnect Loop | `index.js` | 310–321, 381–414 | `runBot()` -> `connection.update` | 408/428 Disconnect Handling & Attempt Accumulation |
| Socket Cleanup | `index.js` | 97–101, 220–224 | `shutdown()`, `runBot()` | Delayed Teardown & Socket Leaks |
| Poller Leaks | `src/handler.js` | 110–138 | `startReminderPoller()` | Active Timer / Interval Leak |
| Radar Leaks | `src/commands/radar.js` | 171–191 | `startRadarEngine()` | Active Timer / Interval Leak |
| Ready State | `src/handler.js` | 142–151 | `markBotReady()`, `isBotReady()` | Stale State & Sync Race Condition |
| Message Handler | `src/events/messages.js` | 44–50 | `bindMessagesEvents()` | Execution of Offline Messages on Reconnect |
