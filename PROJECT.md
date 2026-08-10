# Project: Auth Module Refactoring & Optimization

## Architecture
- `src/auth/redisSession.js`: Custom Baileys authentication state store backed by Redis (ioredis). Provides atomic batch key reads/writes via Redis pipelines, local L1 LRU caching with TTL, and key tombstoning during Bad MAC recovery.
- `src/auth/badMacInterceptor.js`: Intercepts Baileys/Signal Bad MAC crypto decryption errors via monkey-patched console methods and process `unhandledRejection` hooks, rate-limiting log spam and executing targeted session/sender-key purges.
- `index.js`: Main application entry point, initializes Redis connection, bad MAC interceptor, and Baileys socket.

## Feature Inventory
| # | Feature / Refactoring Item | Description | Target File | Milestone | Source |
|---|-------------------|-------------|-------------|-----------|--------|
| 1 | Tombstone Clearance on Key Save | Delete `_purgedKeys` tombstone entry when `keys.set()` writes a newly established session key, preventing 10s read blocks after recovery | `src/auth/redisSession.js` | M1 | Explorers 1, 2, 3 |
| 2 | L1 Cache Eviction & Concurrency Fix | Fix L1 cache insertion-order behavior on key update (true LRU) and update/delete L1 cache immediately during `keys.set` rather than after pipeline.exec() | `src/auth/redisSession.js` | M1 | Explorer 1 |
| 3 | Buffer/Data Serialization Optimization | Optimize Buffer JSON serialization/deserialization to reduce payload bloat and improve Redis/L1 performance | `src/auth/redisSession.js` | M1 | Explorer 1 |
| 4 | Safe Batch Deserialization in `keys.get` | Wrap individual key deserialization in try-catch inside `keys.get()` so one corrupt key payload does not fail the entire batch read | `src/auth/redisSession.js` | M1 | Explorer 3 |
| 5 | Clear `_authPromise` on `clearSession` | Reset in-flight `_authPromise` singleton when `clearSession()` is called to prevent returning stale auth state instances | `src/auth/redisSession.js` | M1 | Explorer 3 |
| 6 | Interceptor Fast-Path String Matching | Add fast string substring checks before running regex patterns in `isSuppressible` to optimize console shimming | `src/auth/badMacInterceptor.js` | M1 | Explorer 2 |
| 7 | Recursive Error Cause Extraction | Enhance `extractKeyId` and `_unhandledHandler` to recursively check `err.cause` / `err.reason` for nested Bad MAC key IDs before escalation | `src/auth/badMacInterceptor.js` | M1 | Explorer 2, Reviewer 2 |
| 8 | Circuit Breaker Robustness | Preserve circuit breaker failure counter if `purgeAllKeysForJid` rejects asynchronously and align `<user>.<device>` key matching | `src/auth/badMacInterceptor.js` | M1 | Explorer 2, Reviewer 2 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Auth Refactoring & Hardening | Items 1-8 in `src/auth/redisSession.js` and `src/auth/badMacInterceptor.js` | None | DONE |
| M2 | Code Validity & Quality Gate | Verification (`node -c`), review by Reviewers, Challenger, Forensic Auditor | M1 | DONE |

## Interface Contracts
### `src/auth/redisSession.js`
- Exported functions: `useRedisAuthState(redisClient, sessionPrefix)` (async, returns `{ state, saveCreds, clearSession }`), `getRedisClient()`, `closeRedisClient()`.
- Auth state structure: `state.creds` (AuthenticationCredentials), `state.keys.get(type, ids)` (batch fetch), `state.keys.set(data)` (batch write).

### `src/auth/badMacInterceptor.js`
- Exported functions: `installBadMacInterceptor(purgeCorruptKey, getSessionId, purgeAllKeysForJid)`.
- Contract: Intercepts console logs and process unhandled rejections without breaking non-Signal exception propagation.

## Code Layout
- `src/auth/redisSession.js`: Redis session auth state implementation
- `src/auth/badMacInterceptor.js`: Bad MAC error interceptor and purge handler
