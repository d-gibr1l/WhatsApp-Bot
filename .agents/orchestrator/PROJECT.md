# PROJECT: WhatsApp Bot Session Management & Decryption Error Handling Refactoring

## Architecture
The application is a Baileys-based WhatsApp bot utilizing Redis for authentication session state storage, Supabase/SQLite for persistent data, and an interceptor architecture for handling Bad MAC signal decryption errors.

### Subsystems Covered
1. **Auth & Session Persistence Layer** (`src/auth/redisSession.js`):
   - Handles multi-device Signal protocol session keys, pre-keys, and app state keys in Redis.
   - Maintains an in-memory L1 cache and a 10s purged keys tombstone map (`_purgedKeys`).
2. **Bad MAC Decryption Interceptor & Error Scoping** (`src/auth/badMacInterceptor.js`, `src/handler.js`, `index.js`):
   - Intercepts console logs and unhandled rejections for Signal decryption errors.
   - Implements per-chat JID rate-limiting and a circuit breaker for bad MAC purges.
3. **Cache & Ephemeral Data Management** (`src/cache.js`, `src/commands/antidelete.js`):
   - Manages memory caches for settings, admins, banned users, and message deduplication.
   - Controls background database sync intervals and message history buffers.
4. **Tooling & Infrastructure** (`eslint.config.js`, `package.json`, `src/db.js`):
   - Provides linting rules and test execution setup.

---

## Feature Inventory

| # | Feature / Issue | Description | Milestone | Source |
|---|-----------------|-------------|-----------|--------|
| 1 | **Amnesia Vulnerability & Pipeline Error Bubbling** | Ensure transient Redis drops/errors bubble up without overwriting valid session credentials with empty states. | M1 | R1, R2 |
| 2 | **`_purgedKeys` Tombstone Recovery Fix** | Clear key from `_purgedKeys` when `keys.set` writes a new key to eliminate 10s recovery delay after Bad MAC purge. | M1 | R1, R2 |
| 3 | **L1 Cache Synchronous Updates & LRU Refresh** | Update L1 cache synchronously before `pipeline.exec()` to eliminate race conditions; refresh insertion order on `.set()`. | M1 | R1 |
| 4 | **Catastrophic Global Session Wipe Fix** | Prevent empty/unextractable JID from calling `purgeAllKeysForJid('')` which generates glob `${sessionId}:session-.*` and wipes all sessions bot-wide. | M2 | R1, R2 |
| 5 | **Per-Chat JID Scoped Bad MAC Rate Limiting** | Ensure fallback rate limiting uses `console:mac:${sessionId}:unknown` instead of global session key, preventing cross-chat log suppression. | M2 | R2 |
| 6 | **Silent Suppressible Log Drop Fix** | Add structured logging fallback for non-BadMAC suppressible log patterns (`'Failed to decrypt message'`, `'Session error:'`, etc.). | M2 | R1, R2 |
| 7 | **Diagnostic Visibility & Disconnect Error Logging** | Make Pino logger level configurable and log `lastDisconnect.error.message`/stack trace in `index.js`. | M2 | R1 |
| 8 | **Unbounded Map GC Fix in `antidelete.js`** | Replace unbounded `groupMetaCache` Map with LRUCache to prevent progressive RAM memory leaks. | M3 | R1 |
| 9 | **Cache Reference Stability & Realtime Fallback Fix** | Mutate `cache` Set/Map objects in-place in `loadCache()` to preserve references; initiate polling fallback on `CHANNEL_ERROR`. | M3 | R1 |
| 10 | **Test Runner Process Hang Fix** | Add `.unref()` to top-level `setInterval` in `src/db.js` so `npm test` exits cleanly. | M3 | R1, AC |
| 11 | **ESLint Infrastructure & Code Quality** | Update `eslint.config.js` to include `@eslint/js` recommended config and target `index.js` for `npm run lint`. | M3 | R1, AC |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| **M1** | **Session Management & Amnesia Prevention** | Refactor `src/auth/redisSession.js` & pipeline error handling to ensure amnesia safety, synchronous L1 updates, and proper `_purgedKeys` deletion. | None | DONE |
| **M2** | **Bad MAC Error Handling & Per-Chat Scoping** | Refactor `src/auth/badMacInterceptor.js`, `src/handler.js`, and `index.js` for per-chat rate-limiting, empty JID wipe prevention, and full log visibility. | M1 | DONE |
| **M3** | **Ephemeral Data GC, Cache Stability & Infrastructure** | Refactor `src/cache.js`, `src/commands/antidelete.js`, `src/db.js`, and `eslint.config.js` to fix memory leaks, reference stability, test runner hang, and pass `npm run lint`. | M1, M2 | DONE |

---

## Interface Contracts

### `src/auth/redisSession.js` ↔ `src/auth/badMacInterceptor.js`
- `purgeCorruptKey(key)`: Deletes key from L1 cache and Redis, and adds to `_purgedKeys` with 10s TTL.
- `purgeAllKeysForJid(jid)`: Purges all session and sender keys for a specific JID. **Contract**: If `!jid` or `!base`, function MUST immediately return 0 without executing any Redis glob deletes.
- `keys.set(data)`: Writes keys to Redis and updates L1 cache. **Contract**: MUST call `_purgedKeys.delete(key)` for every key being set, and MUST update L1 cache synchronously before pipeline execution.

### `src/auth/badMacInterceptor.js` ↔ `index.js`
- `initBadMacInterceptor(options)`: Configures console log interceptor and `unhandledRejection` listener.
- `purgeForBadMac(keyInfo)`: Extracts base JID and purges key or triggers circuit breaker for JID. **Contract**: If `!baseJid`, MUST return early without tracking or purging.

---

## Code Layout

- `src/auth/redisSession.js`: Redis session state storage, L1 caching, pipeline execution, key purging.
- `src/auth/badMacInterceptor.js`: Console interception, error pattern matching, per-chat rate limiting, circuit breaker.
- `src/cache.js`: Global settings cache, LRU caches for message IDs, auto-refresh and realtime listeners.
- `src/commands/antidelete.js`: Antidelete message store (LRUCache) and group metadata cache (`groupMetaCache`).
- `src/db.js`: Database client, connection management, log buffer flushing interval.
- `src/handler.js`: Main message handling dispatcher.
- `index.js`: Main bot entry point, Baileys socket initialization, connection status event handling.
- `eslint.config.js`: ESLint configuration file.
