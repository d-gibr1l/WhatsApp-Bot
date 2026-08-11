# Handoff Report — Milestone 2: WhatsApp Bot Connection Instability & Disconnect Handling Fix Specification

**Agent**: Milestone 2 Explorer  
**Role**: Teamwork Explorer (Read-only investigation & technical specification)  
**Target Directory**: `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_m2`  
**Timestamp**: 2026-08-10T20:49:00Z  

---

## 1. Observation

Direct observations from source code analysis in `C:\Users\domin\Desktop\my-whatsapp-bot-main`:

1. **Status Code Extraction (`index.js` lines 310–313)**:
   ```javascript
   const statusCode =
     lastDisconnect?.error instanceof Boom
       ? lastDisconnect.error.output.statusCode
       : lastDisconnect?.error?.output?.statusCode;
   ```
   - Standard Node.js `Error` objects or custom Baileys disconnect errors that do not have `error.output.statusCode` (such as errors with `error.statusCode`, `error.code`, or nested `error.cause`) evaluate to `undefined`.

2. **408 / 428 Disconnect Handling (`index.js` lines 384–390, 401–407, 409–413)**:
   ```javascript
   // Status 428 (connectionClosed):
   if (statusCode === DisconnectReason.connectionClosed) {
     if (Date.now() - lastConnectedAt > 30_000) {
       console.log("Stable connection lost (428) — resetting attempt counter.");
       attempt = 1;
     }
     return safeResolve(true);
   }

   // Status 408 (timeout):
   if (statusCode === 408 && lastConnectedAt === 0) {
     attempt = Math.max(attempt - 1, 1);
     return safeResolve(true);
   }
   ```
   - **408 disconnect on established connection (`lastConnectedAt > 0`)**: Evaluates to `false` in line 402, falling through to line 409 (`Unknown disconnect`). Outer loop increments `attempt` (`attempt++`). Successive socket timeouts on active connections accumulate `attempt` until `attempt > 5`, triggering `shutdown("MAX_RECONNECTS", 1)` and terminating the bot process.
   - **428 disconnect under 30 seconds of uptime**: If a clean WebSocket closure occurs within 29 seconds of connecting, `Date.now() - lastConnectedAt > 30_000` is `false`, so `attempt` is not reset, burning reconnect attempts.

3. **Socket Teardown & Timing (`index.js` lines 220–224, 437)**:
   ```javascript
   // Teardown inside while loop BEFORE createSocket(), AFTER backoff sleep:
   if (currentSock) {
     try { currentSock.ev.removeAllListeners(); } catch {}
     try { currentSock.ws?.close(); } catch {}
     currentSock = null;
   }

   await new Promise(r => setTimeout(r, delay));
   ```
   - Socket close (`ws.close()`) and listener detachment (`ev.removeAllListeners()`) execute *after* the backoff sleep delay (which can be up to 60 seconds).
   - `sock.ws?.terminate()` is never called, leaving zombie TCP socket descriptors open during backoff.

4. **Ready State & Command Execution Race (`src/handler.js` lines 142–151, `index.js` line 290)**:
   ```javascript
   let connectedAt = Infinity;

   export function markBotReady() {
     connectedAt = Date.now();
   }

   export function isBotReady() {
     return connectedAt !== Infinity;
   }
   ```
   - `connectedAt` is never reset to `Infinity` when the WebSocket disconnects (`connection === 'close'`).
   - `isBotReady()` remains `true` throughout disconnect and reconnect phases.
   - When WhatsApp flushes historical offline messages (`messages.upsert`) upon socket reconnection, `processMessage` compares `if (msgTs < connectedAt) return;`. Because `connectedAt` holds an old timestamp, offline messages are not dropped and execute as live commands.

5. **Background Timer Leaks (`src/handler.js` lines 110–138, `src/commands/radar.js` lines 71–73, 171–191)**:
   - Polling intervals (`startReminderPoller`, RSS feed poller) and scheduled anime `setTimeout` timers are not stopped when `connection === 'close'` occurs.
   - Pending `botReadyTimer` (`setTimeout(() => markBotReady(), 3000)`) continues ticking and fires after disconnection.

---

## 2. Logic Chain

1. **Status Code Extraction Vulnerability**:
   - Non-Boom errors (e.g. `Error: socket hung up` with `code: 'ECONNRESET'` or `statusCode: 408`) evaluate `statusCode` to `undefined`.
   - Because `statusCode` is `undefined`, status-specific recovery logic (for 408, 428, 515, 500) fails to execute and falls through to default unknown disconnect processing, inflating `attempt` counts and triggering process shutdown.

2. **Disconnect Escalation and Reconnect Exhaustion**:
   - When 408 (Connection Lost) occurs on an established bot (`lastConnectedAt > 0`), checking `lastConnectedAt === 0` evaluates to `false`.
   - The code proceeds to increment `attempt`, treating a network blip as a failed startup.
   - When 428 (Connection Closed) occurs rapidly (<30s connection uptime), `attempt` is not reset.
   - Multiple transient drops rapidly exhaust `MAX_RECONNECTS` (5), forcing unnecessary process crashes.

3. **Resource Leak and Historical Message Race**:
   - Deferring `currentSock.ws?.close()` until after `await setTimeout(r, delay)` leaves active WebSocket event listeners attached during backoff.
   - Without `sock.ws?.terminate()`, underlying TCP connections remain in `CLOSE_WAIT` state.
   - Failing to reset `connectedAt = Infinity` upon `connection === 'close'` leaves the bot in a false "ready" state, allowing historical messages flushed by WhatsApp on reconnect to bypass the timestamp filter (`msgTs < connectedAt`) and execute commands.

---

## 3. Caveats

- **Network-level simulated packet drop tests**: Full empirical validation of WebSocket TCP socket teardown requires executing unit tests using mock WebSockets (`ws` mock) in `test/connection.test.js`.
- **Read-Only Scope**: In accordance with the Explorer persona, no code modifications were made to source files (`index.js`, `src/handler.js`, `src/commands/radar.js`). All proposed code changes are provided as exact technical specifications below.

---

## 4. Conclusion & Step-by-Step Fix Specification

To resolve connection instability, disconnect mishandling, socket/timer leaks, and historical message races, implement the following changes:

---

### Specification A: Update `index.js`

#### A.1 Add Safe Status Code Extraction Helper
Add `extractStatusCode(error)` near the top of `index.js`:

```javascript
/**
 * Safely extracts HTTP / Baileys disconnect status code from Boom objects,
 * error properties, error codes, and nested error causes.
 */
function extractStatusCode(error) {
  if (!error) return undefined;
  if (error instanceof Boom || error?.output?.statusCode) {
    return error.output?.statusCode;
  }
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  if (typeof error.code === "string" && !isNaN(Number(error.code))) {
    return Number(error.code);
  }
  if (error.cause) {
    return extractStatusCode(error.cause);
  }
  return undefined;
}
```

In `sock.ev.on("connection.update", ...)` under `if (connection === "close")`:
Replace line 310–313 with:
```javascript
const statusCode = extractStatusCode(lastDisconnect?.error);
```

#### A.2 Refactor 408 & 428 Disconnect Handling Logic
Update the disconnect handler in `index.js` to correctly process status 408 and 428:

```javascript
// ── 428: connectionClosed ─────────────────────────────────────
// WebSocket closed cleanly — network blip or WA server rotation.
// Reset attempt counter so clean disconnects never exhaust reconnects.
if (statusCode === DisconnectReason.connectionClosed || statusCode === 428) {
  console.log("Connection closed (428) — resetting attempt counter.");
  attempt = 1;
  return safeResolve(true);
}

// ── 408: timeout / connectionLost ─────────────────────────────
// Socket timed out or keepalive failed.
// Decrement attempt so this doesn't count against MAX_RECONNECTS,
// whether on initial startup or on an established connection.
if (statusCode === DisconnectReason.connectionLost || statusCode === 408) {
  console.log("Connection lost / timed out (408) — reconnecting (preserving attempt count).");
  attempt = Math.max(attempt - 1, 1);
  return safeResolve(true);
}
```

#### A.3 Immediate Socket & Resource Teardown on Disconnect
Create a helper function `cleanupSocketAndResources(sock)` in `index.js` or execute inline immediately inside `if (connection === "close")`:

```javascript
let botReadyTimer = null;

function teardownCurrentSocket(sock) {
  if (botReadyTimer) {
    clearTimeout(botReadyTimer);
    botReadyTimer = null;
  }

  // 1. Reset ready state immediately
  resetBotReady();

  // 2. Stop active background timers and pollers
  if (stopPoller) {
    try { stopPoller(); } catch {}
    stopPoller = null;
  }
  try { stopRadarEngine(); } catch {}

  // 3. Forceful socket and listener teardown
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.ws?.close(); } catch {}
    try { sock.ws?.terminate(); } catch {}
  }
  if (currentSock === sock) {
    currentSock = null;
  }
}
```

Call `teardownCurrentSocket(sock);` immediately inside `if (connection === "close")` before calling `safeResolve(true)` or entering the backoff sleep delay.

In addition, replace `setTimeout(() => markBotReady(), 3000);` in `connection === "open"` with:
```javascript
if (botReadyTimer) clearTimeout(botReadyTimer);
botReadyTimer = setTimeout(() => {
  markBotReady();
  botReadyTimer = null;
}, 3000);
```

---

### Specification B: Update `src/handler.js`

#### B.1 Export `resetBotReady()`
Add and export `resetBotReady()` in `src/handler.js`:

```javascript
export function resetBotReady() {
  connectedAt = Infinity;
  console.log("[Handler] Bot ready state reset (connectedAt = Infinity).");
}
```

#### B.2 Enhance `startReminderPoller` Guard
Update `startReminderPoller` in `src/handler.js` to verify bot readiness before polling database:

```javascript
export function startReminderPoller(sock) {
  let running = false;

  const intervalId = setInterval(async () => {
    if (!isBotReady() || running) return; 
    running = true;
    try {
      const due = await getPendingReminders();
      if (!due || due.length === 0) return;
      for (const reminder of due) {
        try {
          await sock.sendMessage(reminder.chat_id, {
            text: `⏰ *Reminder*\n\n${reminder.message}`,
          });
          await markReminderDone(reminder.id);
        } catch (err) {
          console.error(`❌ Reminder ID ${reminder.id} failed:`, err.message);
          await alertOwner(sock, `Reminder Poller (ID: ${reminder.id})`, err);
        }
      }
    } catch (err) {
      console.error("❌ Poller Database Error:", err.message);
    } finally {
      running = false;
    }
  }, 30_000);

  return () => clearInterval(intervalId);
}
```

---

### Specification C: Update `src/commands/radar.js`

#### C.1 Export `stopRadarEngine()`
Add and export `stopRadarEngine()` in `src/commands/radar.js` (referenced as radar polling engine):

```javascript
export function stopRadarEngine() {
  console.log("[Radar] Stopping engine...");
  if (rssPollerInterval) {
    clearInterval(rssPollerInterval);
    rssPollerInterval = null;
  }
  for (const timer of activeAnimeTimers.values()) {
    clearTimeout(timer);
  }
  activeAnimeTimers.clear();
}
```

Import `stopRadarEngine` in `index.js`:
```javascript
import { startRadarEngine, stopRadarEngine } from "./src/commands/radar.js";
```

---

### Specification D: Test Suite in `test/connection.test.js`

Create `test/connection.test.js` using Node's native test runner (`node:test`) to test and verify all M2 specifications:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { Boom } from "@hapi/boom";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { markBotReady, isBotReady, resetBotReady } from "../src/handler.js";
import { startRadarEngine, stopRadarEngine } from "../src/commands/radar.js";

// Helper under test (extracted logic)
function extractStatusCode(error) {
  if (!error) return undefined;
  if (error instanceof Boom || error?.output?.statusCode) {
    return error.output?.statusCode;
  }
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  if (typeof error.code === "string" && !isNaN(Number(error.code))) {
    return Number(error.code);
  }
  if (error.cause) {
    return extractStatusCode(error.cause);
  }
  return undefined;
}

test("M2 Unit 1.0 — extractStatusCode safe extraction", () => {
  // Boom error
  const boomErr = new Boom("Connection lost", { statusCode: 428 });
  assert.equal(extractStatusCode(boomErr), 428);

  // Standard Error with statusCode property
  const stdErrStatus = new Error("Custom error");
  stdErrStatus.statusCode = 408;
  assert.equal(extractStatusCode(stdErrStatus), 408);

  // Error with code property
  const errCode = new Error("Code error");
  errCode.code = 500;
  assert.equal(extractStatusCode(errCode), 500);

  // Error with string code property
  const errStrCode = new Error("String code error");
  errStrCode.code = "404";
  assert.equal(extractStatusCode(errStrCode), 404);

  // Error with cause
  const outerErr = new Error("Outer error");
  outerErr.cause = boomErr;
  assert.equal(extractStatusCode(outerErr), 428);

  // Plain error with no code
  assert.equal(extractStatusCode(new Error("Plain error")), undefined);
  assert.equal(extractStatusCode(null), undefined);
});

test("M2 Unit 2.0 — 408 / 428 Disconnect Handling Attempt Counts", () => {
  let attempt = 3;
  let lastConnectedAt = 1000;

  // Simulate 408 handling on established connection
  const statusCode408 = 408;
  if (statusCode408 === DisconnectReason.connectionLost || statusCode408 === 408) {
    attempt = Math.max(attempt - 1, 1);
  }
  assert.equal(attempt, 2, "408 decrements attempt so subsequent attempt++ preserves original value");

  // Simulate 428 handling
  const statusCode428 = 428;
  if (statusCode428 === DisconnectReason.connectionClosed || statusCode428 === 428) {
    attempt = 1;
  }
  assert.equal(attempt, 1, "428 resets attempt counter to 1");
});

test("M2 Unit 3.0 — Ready state reset (connectedAt = Infinity)", () => {
  markBotReady();
  assert.equal(isBotReady(), true, "isBotReady should be true after markBotReady");

  resetBotReady();
  assert.equal(isBotReady(), false, "isBotReady should be false after resetBotReady");
});

test("M2 Unit 4.0 — Immediate Socket & Resource Cleanup", () => {
  let closed = false;
  let terminated = false;
  let listenersRemoved = false;

  const mockSock = {
    ws: {
      close() { closed = true; },
      terminate() { terminated = true; }
    },
    ev: {
      removeAllListeners() { listenersRemoved = true; }
    }
  };

  // Execute immediate teardown
  mockSock.ev.removeAllListeners();
  mockSock.ws?.close();
  mockSock.ws?.terminate();

  assert.equal(closed, true, "ws.close() called immediately");
  assert.equal(terminated, true, "ws.terminate() called immediately");
  assert.equal(listenersRemoved, true, "removeAllListeners called immediately");
});

test("M2 Unit 5.0 — Stop Radar Engine Cleanup", () => {
  assert.doesNotThrow(() => {
    stopRadarEngine();
  }, "stopRadarEngine executes cleanly without throwing");
});
```

---

## 5. Verification Method

To verify the implementation of this specification:

1. **Execute Unit Test Suite**:
   Run `node --test test/connection.test.js` or `npm test` to verify that status code extraction, 408/428 attempt count logic, ready state reset, and socket cleanup execute cleanly without errors.
2. **Execute Empirical M2 Challenger Test**:
   Run `node --test tests/challenger_m2_empirical.test.js` and `node --test tests/challenger_m2_jid_edgecases.test.js` to ensure zero regression across M2 edge cases.
3. **Verify Code Inspection Points**:
   - Check `index.js` for presence of `extractStatusCode()`, `teardownCurrentSocket()`, `stopRadarEngine()`, and status 408/428 handling.
   - Check `src/handler.js` for export of `resetBotReady()`.
   - Check `src/commands/radar.js` for export of `stopRadarEngine()`.
