# Project: WhatsApp Bot Connection Instability & Session Error Fixes

## Architecture
The application is a Baileys-based WhatsApp bot with Redis session persistence.
- **Entry point & connection manager**: `index.js` manages socket creation (`makeWASocket`), connection lifecycle, reconnection backoff loops, event listeners, and startup data loaders.
- **Auth & Session store**: `src/auth/redisSession.js` handles credential state and keys in Redis.
- **Error Interceptor**: `src/auth/badMacInterceptor.js` installs global `unhandledRejection` and `uncaughtException` listeners to intercept libsignal decryption failures (Bad MAC, Key used already, Session errors) and prevent Node.js process crashes.
- **Handlers & Timers**: `src/handler.js`, `src/radarEngine.js`, and `src/reminderPoller.js` manage incoming message handling and scheduled background tasks.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | `SessionError` Pattern Interception | Add `No session record` and `No matching sessions found for message` to `SUPPRESS_PATTERNS` in `badMacInterceptor.js` | M1 | Survey Explorer 1 / ORIGINAL_REQUEST |
| F2 | Layer 2 `_unhandledHandler` Refactor | Update `_unhandledHandler` in `badMacInterceptor.js` to suppress all `SUPPRESS_PATTERNS` and session errors instead of calling `escalateRejection` via `setImmediate` | M1 | Survey Explorer 1 & 3 |
| F3 | Disconnect Code Processing | Extract error status codes correctly from Boom and non-Boom errors; differentiate 408 & 428 disconnects; handle initial setup vs established drops | M2 | Survey Explorer 2 / ORIGINAL_REQUEST |
| F4 | Immediate Socket & Resource Cleanup | Teardown sockets (`close()`, `terminate()`), remove event listeners, and clear background timers (`startReminderPoller`, `startRadarEngine`, `markBotReady`) immediately upon disconnect | M2 | Survey Explorer 2 |
| F5 | Reconnect State & Command Race Reset | Reset `connectedAt` to `Infinity` on disconnect to prevent historical offline message flush from executing as commands; track ready timers | M2 | Survey Explorer 2 |
| F6 | Async Setup Error Boundaries | Wrap async setup calls (`loadCache`, `loadWordFilter`, `loadAllowedLinks`, `loadAliases`, `loadSeenMessages`) and `init queries` in `connection.update` with `try...catch` | M3 | Survey Explorer 3 / ORIGINAL_REQUEST |
| F7 | Process Error Boundary & Guard Refactor | Refactor `uncaughtException` handler for graceful shutdown; fix flawed `listenerCount > 1` guard in `badMacInterceptor.js` | M3 | Survey Explorer 3 |
| F8 | Integration & E2E Test Suite | Build opaque-box E2E and unit test suite covering disconnect scenarios, session error suppression, and timeout boundaries | M4 | Dual Track E2E |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Session Error Interception & Suppression | `src/auth/badMacInterceptor.js` | None | DONE |
| M2 | Disconnect Code Processing & Socket Teardown | `index.js`, background timers (`src/handler.js`, `src/radarEngine.js`) | M1 | DONE |
| M3 | Connection Setup Error Boundaries & Process Handlers | `index.js`, `src/auth/badMacInterceptor.js` | M1, M2 | DONE |
| M4 | Integration & E2E Verification Track | Test suite in `test/` and `TEST_READY.md` | M1, M2, M3 | IN_PROGRESS |

## Interface Contracts
### `src/auth/badMacInterceptor.js`
- Export: `installBadMacInterceptor(purgeCorruptKey, getSessionId, purgeAllKeysForJid)`
- Behavior: Must register `unhandledRejection` listener. Must catch `Bad MAC`, `MessageCounterError`, `SessionError: No session record`, and `SessionError: No matching sessions found for message`. Must log rate-limited warning and MUST NOT throw uncaught exception.

### Connection State (`index.js`)
- `connectedAt`: `number` (timestamp when socket reaches `open` and setup completes) or `Infinity` (when socket is disconnected / connecting).
- `isBotReady()`: Returns `true` ONLY if socket state is open AND `connectedAt` is a valid past timestamp AND bot ready timer has fired.
- Cleanup Contract: When `connection.update` receives `{ connection: 'close' }`, `sock.ws?.terminate()`, `sock.ev.removeAllListeners()`, and all interval handles MUST be immediately invalidated before backoff delay.

## Code Layout
- `index.js` — Main bot entry, socket lifecycle, connection.update handler, global process error handling.
- `src/auth/badMacInterceptor.js` — Decryption error and unhandled rejection interceptor.
- `src/auth/redisSession.js` — Redis session & key store.
- `src/handler.js` — Message handling logic.
- `src/radarEngine.js` — Radar polling engine.
- `src/reminderPoller.js` — Reminder polling engine.
- `test/` — Unit and integration tests.
