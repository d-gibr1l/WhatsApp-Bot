# Codebase Analysis: WhatsApp Bot Session Errors & badMacInterceptor.js

**Author**: Survey Explorer 1  
**Date**: 2026-08-10  
**Target Project Root**: `C:\Users\domin\Desktop\my-whatsapp-bot-main`  
**Focus**: `SessionError: No session record`, `SessionError: No matching sessions found for message`, process crashes, and `badMacInterceptor.js` suppression mechanics.

---

## 1. Executive Summary

This report provides a detailed static and architectural analysis of how Signal protocol session errors (`SessionError: No session record` and `SessionError: No matching sessions found for message`) occur in the Baileys-based WhatsApp bot codebase, why they currently bypass suppression in `src/auth/badMacInterceptor.js`, and how they cause unhandled promise rejections that crash the Node.js process.

### Key Discoveries:
1. **Suppression Bypass in Process Unhandled Rejections**: `src/auth/badMacInterceptor.js` implements a 2-layer suppression mechanism. While Layer 1 (`console.error` shim) checks `isSuppressible()` against `SUPPRESS_PATTERNS`, Layer 2 (`process.on('unhandledRejection')` listener `_unhandledHandler`) **only** checks for `isCounter` (`MessageCounterError` / `Key used already`) and `isBadMac` (`Bad MAC`).
2. **Forced Process Escalation**: In `_unhandledHandler` (lines 318–322), any unhandled rejection that is neither `isCounter` nor `isBadMac` falls through to `escalateRejection(reason)`. `escalateRejection` (lines 202–207) executes `setImmediate(() => { throw reason; })`, which throws an uncaught exception on the event loop tick and forcibly crashes the Node.js process.
3. **Missing Error Patterns**: Neither `SUPPRESS_PATTERNS` nor `_unhandledHandler` in `src/auth/badMacInterceptor.js` explicitly handles `'No session record'` or `'No matching sessions found for message'`.
4. **Cascading Failure Loop**: When a Bad MAC error or corrupted key triggers key purging (`purgeCorruptKey` or `purgeAllKeysForJid`), subsequent incoming messages from that sender arrive before a new Signal prekey exchange completes. These incoming messages throw `SessionError: No session record`. Because Layer 2 escalates `SessionError`, the self-healing key purge directly triggers a Node process crash!

---

## 2. File Index & Roles

| File Path | Role in Session & Error Architecture |
|---|---|
| `src/auth/badMacInterceptor.js` | Intercepts console logging and process `unhandledRejection` events for Signal decryption & session errors; manages key purging and circuit breaker. |
| `src/auth/redisSession.js` | Manages Redis & L1 memory cache persistence for Baileys auth credentials and Signal session keys (`session-*`, `sender-key-*`). |
| `index.js` | Bot startup entry point; initializes logger, attaches `badMacInterceptor`, handles process signals, manages socket reconnect loop and disconnect codes. |
| `src/handler.js` | Handlers for command parsing, message filtering, reminder polling, and owner error alerts (`alertOwner` excludes certain decryption errors). |
| `src/events/messages.js` | Binds Baileys `messages.upsert` and `messages.delete` socket events; enqueues incoming messages into per-JID chat queues. |

---

## 3. Deep-Dive Analysis of Session Error Propagation & Crashes

### 3.1 Origin of Session Errors in Baileys & Libsignal
When WhatsApp delivers encrypted messages (PKmsg / Msg) or group sender keys, `@whiskeysockets/baileys` uses `@whiskeysockets/libsignal-node` to decrypt the ciphertext.
- **`SessionError: No session record`**: Occurs when Baileys queries `keys.get('session', [address])` via `redisSession.js`, receives no session record (returns `{}`/`null`), and passes `null` to `libsignal`. `libsignal` fails because no session record exists for that remote address (`<number>.<device>`).
- **`SessionError: No matching sessions found for message`**: Occurs when a session record exists in storage, but the message header's ratcheting keys/ephemeral keys do not match any active session entry or saved ratchets for that sender.

These errors occur naturally in WhatsApp production environments due to:
- Key eviction or cache miss in Redis/L1 cache.
- Transient network drops during Redis pipeline execution.
- Key purges executed by `badMacInterceptor.js` after bad MACs.
- Incoming messages from a user's companion device before prekey exchange completes.
- Out-of-order message delivery over WebSocket connections.

### 3.2 Error Propagation Path to Process Crash

```
[ Incoming WhatsApp WebSocket Frame ]
                 │
                 ▼
   [ Baileys Signal Decrypt Engine ]
                 │
   (Fails: No session record / No matching session)
                 │
                 ▼
 [ Unhandled Promise Rejection in Baileys Async Pipeline ]
                 │
                 ▼
    [ Node.js process.on('unhandledRejection') ]
                 │
                 ▼
  [ badMacInterceptor.js: _unhandledHandler(reason) ]
                 │
                 ├─► collectErrorTexts(reason) -> msg = "SessionError: No session record"
                 ├─► isCounter = false
                 ├─► isBadMac = false
                 │
                 ▼
    [ line 318: if (!isCounter && !isBadMac) ]  <== EVALUATES TO TRUE!
                 │
                 ├─► _originalConsoleError('Unhandled Rejection:', reason)
                 │
                 ▼
     [ escalateRejection(reason) ]  (lines 202-207)
                 │
                 ▼
 [ setImmediate(() => { throw reason; }) ]  <== UNCATCHABLE EXCEPTION THROWN
                 │
                 ▼
     [ Process Crashes / Container Restarts ]
```

### 3.3 Precise Code Analysis of `src/auth/badMacInterceptor.js`

#### A. Layer 1 vs Layer 2 Interception Discrepancy
- **Layer 1 (Console Shim)** — `isSuppressible(...args)` (lines 78–119):
  ```javascript
  // lines 68-76
  const SUPPRESS_PATTERNS = [
    'Bad MAC',
    'Key used already',
    'MessageCounterError',
    'Failed to decrypt message',
    'Session error:',
    'Closing session: SessionEntry',
    'Closing open session in favor of incoming prekey bundle',
  ];
  ```
  Layer 1 checks string args and nested error text against `SUPPRESS_PATTERNS`.
  *Defect*: `'No session record'` and `'No matching sessions found for message'` are not explicitly listed in `SUPPRESS_PATTERNS`, although `'Session error:'` or keyword matching (`'Session'`, `'session'`) might match some variants if printed via `console.error`.

- **Layer 2 (Process `unhandledRejection` Handler)** — `_unhandledHandler(reason)` (lines 308–356):
  ```javascript
  // lines 308-323
  _unhandledHandler = async (reason) => {
    try {
      const errorTexts = collectErrorTexts(reason);
      const msg = errorTexts.join('\n');
      const isCounter =
        (reason && reason.name === 'MessageCounterError') ||
        msg.includes('Key used already') ||
        msg.includes('MessageCounterError');
      const isBadMac = msg.includes('Bad MAC');

      if (!isCounter && !isBadMac) {
        _originalConsoleError('Unhandled Rejection:', reason);
        escalateRejection(reason);
        return;
      }
  ```
  *Critical Defect*: `_unhandledHandler` does **not** call `isSuppressible()` nor does it inspect `SUPPRESS_PATTERNS`. It **only** checks `isCounter` and `isBadMac`.
  Any `SessionError: No session record` or `SessionError: No matching sessions found for message` rejecting asynchronously in Baileys triggers `!isCounter && !isBadMac === true`.

#### B. The Escalation Mechanism (`escalateRejection`)
- **`escalateRejection`** (lines 202–207):
  ```javascript
  function escalateRejection(reason) {
    if (process.listenerCount('unhandledRejection') > 1) return;
    setImmediate(() => {
      throw reason;
    });
  }
  ```
  When `escalateRejection` is called, it schedules an asynchronous callback via `setImmediate` that unconditionally throws `reason`. Because this exception is thrown outside any promise or try/catch context on the Node event loop, Node.js terminates execution with an uncaught exception, triggering Docker / Koyeb container restarts.

#### C. Purging & Cascading Failure Path (`purgeForBadMac`)
- In `badMacInterceptor.js` (lines 367–417):
  When a Bad MAC occurs, `purgeForBadMac` calls `purgeCorruptKey` or `purgeAllForJid` to delete the corrupted session key in Redis.
  Once deleted, the session record in Redis is gone.
  The remote WhatsApp client sends another message before a new handshake takes place.
  Baileys tries to decrypt it, finds no session record, and throws `SessionError: No session record`.
  `_unhandledHandler` receives `SessionError: No session record`, determines `!isCounter && !isBadMac === true`, calls `escalateRejection`, and **crashes the bot**.
  Thus, the auto-healing mechanism directly triggers process termination.

---

## 4. Disconnect Handling & Connection Instability Analysis in `index.js`

In `index.js` (lines 307–415), disconnects are handled in `sock.ev.on("connection.update")`:

- **428 (connectionClosed)** (lines 384–390):
  Handled gracefully if stable (`Date.now() - lastConnectedAt > 30_000`), attempt counter resets.
- **408 (timeout)** (lines 404–407):
  Handled gracefully during initial pairing (`lastConnectedAt === 0`), attempt counter decremented.
- **500 (badSession)** (lines 368–371) & **515 (restartRequired)** (lines 395–399):
  Handled gracefully without session deletion.
- **440 (connectionReplaced)** (lines 334–338):
  Shuts down immediately without wiping session.
- **Fatal disconnects (401, 403, 405, 409, 412)** (lines 344–361):
  Wipes session credentials via `clearSession()` and shuts down for fresh QR scanning.

---

## 5. Actionable Remediation Plan for `badMacInterceptor.js`

To resolve the container restart loop caused by `SessionError` unhandled rejections, `src/auth/badMacInterceptor.js` must be refactored as follows:

### 1. Update `SUPPRESS_PATTERNS` (lines 68–76)
Add explicit string patterns for session errors:
```javascript
const SUPPRESS_PATTERNS = [
  'Bad MAC',
  'Key used already',
  'MessageCounterError',
  'Failed to decrypt message',
  'Session error:',
  'SessionError',
  'No session record',
  'No matching sessions found',
  'Closing session: SessionEntry',
  'Closing open session in favor of incoming prekey bundle',
];
```

### 2. Update `_unhandledHandler` in `badMacInterceptor.js` (lines 308–356)
Expand rejection handling in Layer 2 to check for session errors and general suppressible patterns:
```javascript
_unhandledHandler = async (reason) => {
  try {
    const errorTexts = collectErrorTexts(reason);
    const msg = errorTexts.join('\n');

    const isCounter =
      (reason && reason.name === 'MessageCounterError') ||
      msg.includes('Key used already') ||
      msg.includes('MessageCounterError');
    const isBadMac = msg.includes('Bad MAC');
    const isSessionError =
      msg.includes('No session record') ||
      msg.includes('No matching sessions found') ||
      msg.includes('SessionError') ||
      msg.includes('Session error') ||
      msg.includes('Failed to decrypt message');

    const isSuppressibleErr = isCounter || isBadMac || isSessionError || isSuppressible(reason);

    if (!isSuppressibleErr) {
      _originalConsoleError('Unhandled Rejection:', reason);
      escalateRejection(reason);
      return;
    }

    const sessionId = getSessionId();
    const keyInfo = extractKeyId(reason);
    const keySuffix = keyInfo?.id ? keyInfo.id : 'unknown_jid';
    const counterKey = `unhandled:counter:${sessionId}:${keySuffix}`;
    const macKey = `unhandled:mac:${sessionId}:${keySuffix}`;
    const sessionErrKey = `unhandled:session:${sessionId}:${keySuffix}`;

    if (isCounter) {
      if (!isRateLimited(counterKey)) {
        _originalConsoleError(
          `[BadMAC] MessageCounterError (unhandled rejection) for session '${sessionId}' — dropped.`
        );
      }
      return;
    }

    if (isSessionError) {
      if (!isRateLimited(sessionErrKey)) {
        _originalConsoleError(
          `[BadMAC] Suppressed unhandled SessionError (${msg.split('\n')[0]}) for session '${sessionId}' — dropped.`
        );
      }
      return;
    }

    if (isBadMac) {
      if (!isRateLimited(macKey)) {
        _originalConsoleError(
          `[BadMAC] Unhandled Bad MAC for session '${sessionId}'. Purging key.`
        );
      }
      if (!keyInfo) return;
      try {
        await purgeForBadMac(keyInfo);
      } catch (err) {
        _originalConsoleError(`[BadMAC] Purge failed for ${keyInfo.type}:${keyInfo.id}:`, err.message);
      }
    }
  } catch (handlerErr) {
    _originalConsoleError('[BadMAC] Exception in unhandledRejection listener:', handlerErr);
  }
};
```

---

## 6. Summary of Findings & Next Steps

1. **Root Cause**: Unhandled rejections of `SessionError: No session record` and `SessionError: No matching sessions found for message` bypass Layer 2 checks in `badMacInterceptor.js`, causing `escalateRejection` to throw via `setImmediate`, crashing the process.
2. **Scope of Impact**: Container restart loops on Koyeb/Docker whenever session keys are purged, missing, or undergoing prekey exchange.
3. **Remediation**: Expand `SUPPRESS_PATTERNS` and `_unhandledHandler` in `src/auth/badMacInterceptor.js` to catch and rate-limit log all session errors without escalating to process exit.
