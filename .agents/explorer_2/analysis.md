# Detailed Technical Analysis: Bad MAC Interceptor (`src/auth/badMacInterceptor.js`)

**Author**: Explorer 2 (teamwork_preview_explorer)  
**Target File**: `src/auth/badMacInterceptor.js`  
**Related Files**: `src/auth/redisSession.js`, `index.js`  
**Date**: 2026-08-03  

---

## 1. Overview of Bad MAC Error Interception & Handling

WhatsApp relies on the Signal Protocol (via `@whiskeysockets/baileys` and `libsignal`) for end-to-end encryption. Decryption failures occur when cryptographic session states get out of sync, out-of-order counter states occur, or session keys become corrupted. In raw Baileys, these manifest as `Bad MAC`, `MessageCounterError`, or `Key used already`.

`src/auth/badMacInterceptor.js` provides a **two-layer interception architecture** that silences log floods, purges invalid cryptographic keys from Redis and memory, and prevents Node.js process crashes without forcing a full user re-authentication.

```
+-----------------------------------------------------------------------------------+
|                                Baileys / libsignal                                |
+----------------------------------------+------------------------------------------+
                                         |
            Console Logs                 |             Unhandled Rejections
                 v                       |                      v
+----------------------------------+     |     +----------------------------------+
| Layer 1: console.error/log Shim  |     |     | Layer 2: unhandledRejection      |
+----------------+-----------------+     |     +----------------+-----------------+
                 |                       |                      |
                 +-------------------+   |   +------------------+
                                     v   v   v
                         +---------------------------+
                         |     extractKeyId()        |
                         +-------------+-------------+
                                       |
                                       v
                         +---------------------------+
                         |     purgeForBadMac()      |
                         +-------------+-------------+
                                       |
                     +-----------------+-----------------+
                     | (Single Error)                    | (Circuit Breaker: >=3 in 60s)
                     v                                   v
        +--------------------------+        +--------------------------+
        |  purgeCorruptKey()       |        |  purgeAllKeysForJid()    |
        |  (Session key in Redis)  |        |  (All user/group keys)   |
        +--------------------------+        +--------------------------+
```

### Layer 1: `console.error` and `console.log` Shim (Lines 252–311)
- **Problem Solved**: Baileys and `libsignal` bypass pino logging (even when set to `"silent"`) and print Signal decryption failures directly to global `console.error` and `console.log`.
- **Mechanism**: On installation, `console.error` and `console.log` are wrapped with shims (`_originalConsoleError`, `_originalConsoleLog`).
- **Suppression Check**: `isSuppressible(...args)` (Lines 90–93) tests if the formatted log arguments match patterns in `SUPPRESS_PATTERNS` (Lines 80–88):
  - `'Bad MAC'`
  - `'Key used already'`
  - `'MessageCounterError'`
  - `'Failed to decrypt message'`
  - `'Session error:'`
  - `'Closing session: SessionEntry'`
  - `'Closing open session in favor of incoming prekey bundle'`
- **Log Rate-Limiting**: For `Bad MAC` errors, `isRateLimited("console:mac:<sessionId>")` throttles log output to **at most 1 log line per session per 10 seconds** (`RATE_LIMIT_MS = 10_000`, Line 33). The multi-line error stack is replaced by a clean single-line entry:
  `[BadMAC] Decryption failure for session '<sessionId>' (key: <keyId>). Baileys is self-healing — message dropped gracefully.`
- **Action**: Extracts the offending key ID using `extractKeyId(...)` and triggers `purgeForBadMac(keyInfo).catch(() => {})`.

### Layer 2: `unhandledRejection` Listener (Lines 315–368)
- **Problem Solved**: Certain decryption failures escape Baileys' internal promise catch blocks and surface as Node.js `unhandledRejection` events, which would crash the Node process under default Node behavior (`--unhandled-rejections=throw`).
- **Mechanism**: Registers a process-level listener `process.on('unhandledRejection', _unhandledHandler)`.
- **Filtering**:
  - **Replay Protection**: If `isCounter` (`MessageCounterError` or `Key used already`), the rejection is dropped silently after a rate-limited log (`unhandled:counter:<sessionId>`). Replay protection errors are expected in out-of-order message delivery and do not require key purges.
  - **Bad MAC**: If `isBadMac` (`Bad MAC`), logs rate-limited notification (`unhandled:mac:<sessionId>`), extracts key info via `extractKeyId(reason)`, and awaits `purgeForBadMac(keyInfo)`.
  - **Unrelated Errors**: If the rejection is *not* a Signal counter or Bad MAC error, it invokes `escalateRejection(reason)`.

---

## 2. Interceptor Registration & Lifecycle Hooks

### Application Registration
- **Invocation Point**: Installed in `index.js` (Line 46):
  `installBadMacInterceptor(purgeCorruptKey, getSessionId, purgeAllKeysForJid);`
- **Timing**: Called immediately on startup *before* `makeWASocket` is invoked, guaranteeing that decryption errors during the initial socket connection handshake are caught.
- **Dependencies**: Receives higher-order functions from `redisSession.js`:
  - `purgeCorruptKey`: Async function `(type, id) => void`
  - `getSessionId`: Function `() => string`
  - `purgeAllKeysForJid`: Async function `(jid) => void`

### Interaction with Baileys Architecture
- Baileys socket options use a silent pino logger (`logger = pino({ level: 'silent' })`).
- Because `libsignal` and Baileys internal worker routines call global `console.error` directly rather than emitting socket event events, global console monkey-patching and process-level event handling are the only effective hooks available to intercept these errors.

### Interceptor Lifecycle Management
- `_installed` state boolean guarantees idempotent calls to `installBadMacInterceptor`.
- **Prune Timer (`_pruneTimer`)**:
  - Started via `startPruneTimer()` (Lines 45–67). Runs every 5 minutes (`5 * 60_000`) with `.unref()` so it does not block Node process exit.
  - Cleans up stale entries in `lastLogTime` (> 100s old), `badMacCounts` (> 60s window), and `_recentlyPurged` (> 2s old).
- **Uninstall (`uninstallBadMacInterceptor()`, Lines 221–233)**:
  - Restores original `console.error` and `console.log`.
  - Removes `unhandledRejection` process listener (`process.off`).
  - Clears `_pruneTimer` interval.
  - Resets all internal tracking Maps (`lastLogTime`, `badMacCounts`, `_recentlyPurged`, `_wipesInFlight`).

---

## 3. Keys and Sessions Purging Logic

### Key Extraction Architecture (`extractKeyId`, Lines 120–186)
`extractKeyId` parses error objects, strings, stack traces, and nested cause/err properties using four regex strategies:

| Strategy | Target Format / Regex | Match Example | Output Type & ID | `exact` Flag |
| :--- | :--- | :--- | :--- | :--- |
| **Pattern 1** | `/at async ([\w.@:+-]+)\s+\[as awaitable\]/` | `at async 551199999999.0 [as awaitable]` | `type: 'session'`, `id: '551199999999.0'` | `true` |
| **Pattern 2** | `/address:\s*([\w.@:+-]+)/` | `address: 551199999999.0` | `type: 'session'`, `id: '551199999999.0'` | `true` |
| **Pattern 3** | `/(\d+)(?::(\d+))?@(?:s\.whatsapp\.net\|lid)(?:\.(\d+))?/` | `551199999999:2@s.whatsapp.net` | `type: 'session'`, `id: '551199999999.2'` | `true` |
| **Pattern 4** | `/(\d+@g\.us)/` | `120363000000000000@g.us` | `type: 'sender-key'`, `id: '120363000000000000@g.us'` | `false` |

- **Exact vs Non-Exact Key Flags**:
  - `exact: true`: ID matches Baileys keystore format (`<user>.<device>`). Can be targeted directly via `purgeCorruptKey('session', id)`.
  - `exact: false`: Only JID recovered (e.g. group JID). Cannot be deleted individually without risk of targeting non-existent keys. Deferred to the circuit breaker or Baileys pre-key self-heal.

### Purge Execution (`purgeForBadMac`, Lines 377–426)

1. **In-Flight Deduplication (`_wipesInFlight`)**:
   - `_wipesInFlight` (Map<baseJid, Promise>) tracks ongoing full wipes.
   - Concurrent Bad MAC errors for the same JID join the existing promise instead of spawning duplicate Redis SCAN/DEL operations.

2. **Circuit Breaker**:
   - `badMacCounts` tracks failures per `baseJid` within a 60-second sliding window (`60_000` ms).
   - If `stats.count >= 3` in 60s for a JID:
     - `badMacCounts` and `_recentlyPurged` entries for `baseJid` are reset *before* awaiting the wipe (atomic execution before async yield).
     - Triggers `purgeAllForJid(baseJid)`.

3. **Single Key Purge (Below Threshold)**:
   - If `!keyInfo.exact`, single key purge is skipped (left to circuit breaker and Baileys pre-key self-heal).
   - Key-level dedup window (`PURGE_DEDUP_MS = 2000` ms): Prevents duplicate single-key purges within 2 seconds.
   - Executes `purgeCorruptKey(keyInfo.type, keyInfo.id)`.

### Redis & L1 Cache Key Disposal Analysis

| Key Type | Redis Key Pattern | Purged on Single Bad MAC? | Purged on Circuit Breaker? | Impact on Session Recovery |
| :--- | :--- | :--- | :--- | :--- |
| `session` | `${sessionId}:session-<user>.<device>` | **Yes** (if exact ID extracted) | **Yes** (scanned via `${sessionId}:session-<base>.*`) | Forces Baileys to drop corrupt Signal session state and request fresh pre-key bundle from server. |
| `sender-key` | `${sessionId}:sender-key-<group>::<user>::<device>` | No | **Yes** (scanned via `${sessionId}:sender-key-*::<base>::*` or group pattern) | Clears corrupt group sender keys for user/group, allowing group sender key re-distribution. |
| `sender-key-memory` | `${sessionId}:sender-key-memory-<group>` | No | **Yes** (for group JID wipes) | Clears group sender-key memory cache. |
| `pre-key` | `${sessionId}:pre-key-<id>` | **No** | **No** | Preserved. Baileys uses local pre-keys to respond to incoming session setup requests. |
| `app-state-sync-key` | `${sessionId}:app-state-sync-key-<id>` | **No** | **No** | Preserved. Keeps chat settings, labels, and app state sync intact. |
| `creds` | `${sessionId}:creds` | **No** | **No** | Preserved. Identity keys & registration IDs remain intact, preventing unwanted QR re-scans. |

### L1 Cache & Tombstoning in `redisSession.js`
- `markKeyPurged(key)` (Lines 34–43 in `redisSession.js`):
  - Evicts key from `_l1Cache` immediately.
  - Adds key to `_purgedKeys` Map with a 10-second TTL (`PURGED_KEY_TTL_MS = 10_000`).
  - `keys.get` in `redisSession.js` checks `_purgedKeys.has(key)`: if present, returns `undefined`, forcing Baileys to treat the key as missing even if background Redis reads complete concurrently.

---

## 4. Error Propagation & Process Stability

### Swallowing vs Logging vs Rethrowing

```
 Rejection Reason / Log Message
              │
              ├── Is Signal Counter Error? (Key used already / MessageCounterError)
              │     └── Log [BadMAC] Replay protection (rate-limited) ──> Swallow (Do not crash)
              │
              ├── Is Bad MAC Error?
              │     └── Log [BadMAC] Purging key (rate-limited) ──> Purge Key in Redis ──> Swallow (Do not crash)
              │
              └── Is Unrelated Exception? (Database error, syntax error, HTTP error, etc.)
                    └── Call escalateRejection(reason)
                          └── setImmediate(() => { throw reason; }) ──> Surfaced to uncaughtException / Node exit
```

### Safety Features
1. **Escalation of Non-Signal Rejections (`escalateRejection`, Lines 194–206)**:
   - Node disables its standard unhandled rejection process termination as soon as any `unhandledRejection` handler is attached.
   - `escalateRejection` checks `process.listenerCount('unhandledRejection') > 1`. If `badMacInterceptor` is the sole listener, it re-throws the unhandled error via `setImmediate(() => { throw reason; })`, allowing Node's native crash / `uncaughtException` handler to process non-Signal errors correctly.
2. **Purge Error Protection**:
   - `purgeForBadMac(keyInfo).catch(() => {})` suppresses errors during purge (e.g. temporary Redis disconnects), preventing secondary unhandled promise rejections during Bad MAC handling.
3. **Automatic Self-Healing**:
   - Deleting the corrupt `session` key from Redis causes Baileys' internal `keys.get('session', ...)` call to return empty. Baileys interprets this as an unestablished session, triggering its built-in pre-key bundle handshake ("Closing open session in favor of incoming prekey bundle") to transparently rebuild the Signal session.

---

## 5. Architectural & Refactoring Recommendations

### Recommendation 1: Performance Fast-Path in `isSuppressible`
- **Current Issue**: In `badMacInterceptor.js` (Lines 90–93):
  ```javascript
  function isSuppressible(...args) {
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    return SUPPRESS_PATTERNS.some((p) => text.includes(p));
  }
  ```
  `args.map(...).join(' ')` allocates arrays and string representations on **every single `console.error` and `console.log` call across the entire application**.
- **Optimization**: Add a zero-allocation fast-path checking `typeof args[0] === 'string'` first:
  ```javascript
  function isSuppressible(...args) {
    if (args.length === 0) return false;
    const first = args[0];
    if (typeof first === 'string') {
      if (SUPPRESS_PATTERNS.some((p) => first.includes(p))) return true;
    }
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    return SUPPRESS_PATTERNS.some((p) => text.includes(p));
  }
  ```

### Recommendation 2: Remove `_purgedKeys` Tombstone on Explicit `keys.set` Writes
- **Current Issue**: In `redisSession.js` (Lines 340–363):
  When a key is purged, `markKeyPurged(key)` adds it to `_purgedKeys` for 10 seconds. If Baileys completes a pre-key handshake in < 10 seconds and calls `keys.set` with a fresh session key, `keys.set` writes to Redis, but `_purgedKeys.has(key)` remains true. Subsequent `keys.get` calls within that 10s window will ignore the newly written key from Redis because `_purgedKeys.has(key)` is still active.
- **Optimization**: In `redisSession.js`, inside `keys.set`, if a non-null value is written for a key, delete it from `_purgedKeys`:
  ```javascript
  if (value) {
    _purgedKeys.delete(key); // Clear tombstone so fresh key is immediately readable
    l1Updates.push({ key, val: normalizeForType(value, category) });
    ...
  }
  ```

### Recommendation 3: Deep Stack Inspection for Wrapped Errors in `extractKeyId`
- **Current Issue**: `extractKeyId` currently checks `errOrObj.err` and `errOrObj.cause`. Newer Baileys / Node error structures sometimes wrap underlying errors in `cause.cause` or `reason.error`.
- **Optimization**: Implement recursive cause chain inspection up to depth 3 to ensure key IDs are extracted reliably regardless of how deeply Baileys wraps the error object.

### Recommendation 4: Circuit Breaker Error Recovery
- **Current Issue**: In `purgeForBadMac` (Line 399), `badMacCounts.delete(baseJid)` is executed immediately when the circuit breaker threshold is hit. If `purgeAllForJid` rejects due to a transient Redis error, `badMacCounts` has already been cleared, requiring 3 more Bad MAC errors before retrying the wipe.
- **Optimization**: Only delete/reset `badMacCounts` if `purgeAllForJid` succeeds, or restore count on rejection.

---

## 6. Conclusion

`src/auth/badMacInterceptor.js` provides an effective, two-layered defense against Signal protocol decryption errors and log pollution. By combining console shimming, process unhandled rejection management, key ID extraction, and sliding-window circuit breakers, it ensures high application uptime and seamless session recovery. Implementing the recommended fast-path string checks and cache tombstone clearing will further enhance performance and key sync reliability.
