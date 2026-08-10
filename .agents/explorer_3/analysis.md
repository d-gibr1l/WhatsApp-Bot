# Comprehensive Auth Architecture Analysis (`src/auth/`)

## Executive Summary
This document presents an in-depth architectural analysis of the authentication subsystem in `src/auth/` (`redisSession.js` and `badMacInterceptor.js`), its integration with `index.js` and Baileys `makeWASocket`, the connection lifecycle, error trapping, and identified edge cases/anti-patterns.

---

## 1. Auth Architecture & Baileys Interface (`src/auth/`)

### 1.1 `src/auth/redisSession.js`
`redisSession.js` is the adapter layer between `ioredis` and Baileys' `AuthenticationState` interface (`{ state: { creds, keys }, saveCreds, invalidate }`).

* **Keyspace & Namespace**:
  * Keys are structured as `${sessionId}:creds` and `${sessionId}:${type}-${id}` (e.g. `session-`, `sender-key-`, `app-state-sync-key-`, `pre-key-`).
  * `getSessionId()` resolves `BOT_NUMBER` from `botConfig.BOT_NUMBER` or `process.env.BOT_NUMBER`, defaulting to `'unknown'`. The namespace is pinned on first call to ensure write/purge operations target the same keyspace.
  * Default key TTL is 90 days (`KEY_TTL_SECONDS = 90 * 24 * 60 * 60`).

* **Two-Tier Caching (L1 + Redis)**:
  * **L1 Cache (`_l1Cache`)**: In-memory `Map` capped at 2,000 entries (`L1_MAX`) using LRU-style eviction (evicts oldest entry on overflow).
  * **Read Path (`keys.get`)**: Checks L1 cache first. Uncached keys are fetched in batch using `redis.pipeline()`.
  * **Write Path (`keys.set`)**: Pipeline batches `SET` (with TTL) and `DEL` commands, updates `_l1Cache`, and tracks in-flight writes.

* **Binary Serialization & Proto Handling**:
  * `serialize()` converts non-Buffer `Uint8Array` objects to `Buffer` before calling `JSON.stringify()`.
  * `deserialize()` uses `bufferReviver` to restore Buffer instances and `normalizeForType()` to convert `app-state-sync-key` plain objects into `proto.Message.AppStateSyncKeyData.fromObject()`.

* **Self-Healing Integrity Check**:
  * `checkIntegrity()` inspects restored credentials for required fields (`noiseKey`, `signedIdentityKey`, `registrationId`, `signedPreKey`).
  * If unparseable or incomplete, it wipes session keys in Redis (`_wipeSessionKeys`) and re-initializes credentials with `initAuthCreds()`.

* **Asynchronous Write Tracking & WAL Flush**:
  * `trackWrite(promise)` wraps write promises into `_pendingWrites` Set.
  * `drainPendingDbWrites()` awaits `Promise.allSettled([..._pendingWrites])` before process shutdown to prevent data loss.

---

### 1.2 `src/auth/badMacInterceptor.js`
`badMacInterceptor.js` provides two-layer suppression and recovery for Signal protocol decryption errors emitted by Baileys/libsignal.

* **Layer 1: Console Output Shim**:
  * Wraps `console.error` and `console.log` to suppress noisy, non-actionable decryption error logs (`Bad MAC`, `Key used already`, `MessageCounterError`, `Failed to decrypt message`, `Session error:`, `Closing session`).
  * Rate-limits Bad MAC warning logs to 1 per key per 10 seconds.

* **Layer 2: Unhandled Rejection Trap**:
  * Intercepts `unhandledRejection` events on `process`.
  * Extracts key references using regex matching on stack traces (`at async <address> [as awaitable]`, `address: <address>`, JID patterns).
  * Escalates non-decrypt rejections back to Node's default handler via `escalateRejection(reason)` if no other listener is registered.

* **Circuit Breaker**:
  * Tracks Bad MAC failures per base JID in `badMacCounts`.
  * If a contact or group triggers >= 3 Bad MAC failures within 60 seconds, it triggers `purgeAllKeysForJid(baseJid)`, wiping all Signal session keys for that JID. In-flight wipes are deduplicated via `_wipesInFlight`.

---

## 2. Lifecycle Analysis

```
                       ┌─────────────────────────┐
                       │   Node.js App Launch    │
                       └────────────┬────────────┘
                                    │
                       ┌────────────▼────────────┐
                       │  installBadMac...()     │
                       └────────────┬────────────┘
                                    │
                       ┌────────────▼────────────┐
                       │     runBot() Loop       │
                       └────────────┬────────────┘
                                    │
                       ┌────────────▼────────────┐
                       │     getAuthState()      │
                       └────────────┬────────────┘
                                    │
                       ┌────────────▼────────────┐
                       │   makeWASocket(...)     │
                       └────────────┬────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          │                                                   │
┌─────────▼─────────┐                               ┌─────────▼─────────┐
│ connection == open│                               │connection == close│
└─────────┬─────────┘                               └─────────┬─────────┘
          │                                                   │
┌─────────▼─────────┐                     ┌───────────────────┴───────────────────┐
│  Bot Ready & Sync │                     │                                       │
└───────────────────┘           ┌─────────▼─────────┐                   ┌─────────▼─────────┐
                                │     Fatal (401...)│                   │ Recoverable (500) │
                                └─────────┬─────────┘                   └─────────┬─────────┘
                                          │                                       │
                                ┌─────────▼─────────┐                   ┌─────────▼─────────┐
                                │  clearSession()   │                   │ Reconnect Backoff │
                                │    & Shutdown     │                   └───────────────────┘
                                └───────────────────┘
```

1. **Initialization**: `installBadMacInterceptor` runs immediately before socket creation. `getAuthState()` connects Redis and initializes/loads auth state.
2. **Socket Creation**: `createSocket()` calls `getAuthState()`, builds `makeWASocket({ auth: state })`, and registers `creds.update` listener to call `saveCreds()`.
3. **Reconnection Strategy**: `runBot()` manages connection retries using exponential backoff (capped at 60s) with 0–3s startup jitter. Attempt counter resets on stable connection (>30s) or successful connect.
4. **Disconnect Classification**:
   * `440 (connectionReplaced)`: Immediate exit without session wipe (new instance owns session).
   * `401, 403, 405, 409, 412`: Unrecoverable session state / logged out; calls `clearSession()` and exits for fresh QR scan.
   * `500, 411, 428, 515, 408`: Recoverable disconnects; reconnects retaining session state.
5. **Shutdown & Cleanup**: `shutdown()` stops poller, removes event listeners, closes socket, awaits `drainPendingDbWrites()`, and calls `closeRedisConnection()`.

---

## 3. Findings: Potential Issues, Bugs & Anti-Patterns

### Finding 1: Purged Key Marker Blocks Newly Saved Keys (`redisSession.js`)
* **Severity**: High (Decryption Self-Healing Stalls)
* **Location**: `src/auth/redisSession.js` (lines 35-43, 315-320, 360-363)
* **Mechanism**:
  When a Bad MAC error occurs, `markKeyPurged(key)` places `key` into `_purgedKeys` with a 10-second TTL (`PURGED_KEY_TTL_MS = 10_000`).
  When Baileys self-heals (re-negotiates pre-keys with the counterparty), it calls `keys.set()` to write the new key.
  However, `keys.set()` does NOT delete `key` from `_purgedKeys`.
  For the remaining duration of the 10-second TTL, subsequent calls to `keys.get()` check `if (raw && !stale && !_purgedKeys.has(key))` and suppress the newly written key from Redis, returning `undefined`.
* **Impact**: Baileys is unable to read the freshly negotiated key for up to 10 seconds, causing repeated decryption failures during self-healing.
* **Remediation**: In `keys.set()`, when setting a new non-null value (`l1Updates`), explicitly call `_purgedKeys.delete(key)`.

### Finding 2: In-Flight `_authPromise` Leak on Session Wipe (`redisSession.js`)
* **Severity**: Medium (Stale Auth State Reference)
* **Location**: `src/auth/redisSession.js` (lines 210-216, 420-429)
* **Mechanism**:
  `clearSession()` increments `_authGeneration++` and nulls `_authInstance`, but leaves `_authPromise` intact.
  If `clearSession()` is called while `_buildAuthState()` is executing asynchronously, a concurrent or subsequent call to `getAuthState()` will return `_authPromise`.
  `_buildAuthState()` detects `generation !== _authGeneration` and returns an invalidated instance (`stale = true`).
  The caller receives a stale auth instance whose `saveCreds` and `keys.set` calls are silently ignored.
* **Remediation**: `clearSession()` and `closeRedisConnection()` should reset `_authPromise = null`.

### Finding 3: Non-Error Bad MAC Rejections Logged by `index.js` Handler (`index.js`)
* **Severity**: Low (Log Noise)
* **Location**: `index.js` (lines 104-114)
* **Mechanism**:
  The `unhandledRejection` handler in `index.js` checks `if (reason instanceof Error)` before examining `reason.message`. If a rejection reason is a string or plain object (which `badMacInterceptor.js` handles), `index.js` bypasses the filter and logs `Unhandled Rejection: [object Object]`.
* **Remediation**: Normalize `reason` to string (e.g. `String(reason?.message ?? reason)`) before checking suppression patterns in `index.js`.

### Finding 4: Single Key Parse Error Aborts Entire Batch in `keys.get` (`redisSession.js`)
* **Severity**: Low (Resilience)
* **Location**: `src/auth/redisSession.js` (lines 305-325)
* **Mechanism**:
  Inside `keys.get()`, `deserialize(raw, type)` is called inside the loop iterating over `pipeline.exec()` results. If a single key in Redis contains malformed JSON, `deserialize` throws a `SyntaxError`, causing the entire `for` loop to abort to the `catch` block and discarding all remaining valid keys in that batch.
* **Remediation**: Wrap individual `deserialize` calls in a local `try/catch` block inside the loop.

---

## 4. Bot Startup Flow & Syntax Verification

* **Syntax Verification**: Passed `node -c` on all target files:
  `node -c src/auth/redisSession.js src/auth/badMacInterceptor.js index.js` (Exit code 0).
* **Dependencies**: Verified `@whiskeysockets/baileys`, `ioredis`, `@hapi/boom`, and `pino` are correctly defined in `package.json` with compatible version bounds.
