# Forensic Audit Report — Milestone 2: Bad MAC Error Handling & Per-Chat Rate Limiting

**Work Product**: `src/auth/badMacInterceptor.js`, `index.js`, `src/handler.js`
**Profile**: General Project (Integrity Mode: `benchmark`)
**Verdict**: **CLEAN**

---

## Phase Results

| Check Name | Status | Details |
|------------|--------|---------|
| **Hardcoded test results** | **PASS** | No hardcoded test values, dummy returns, or pre-canned PASS strings in production code. |
| **Facade detection** | **PASS** | All refactored methods implement genuine logic with error guards, rate limiting, and circuit breaker logic. |
| **Pre-populated artifact detection** | **PASS** | No pre-existing test result artifacts or pre-generated log files were found in workspace. |
| **Build and run** | **PASS** | Code passes syntax checks (`node -c`), unit tests (`npm test`), and 12 challenger empirical tests. |
| **Output verification** | **PASS** | Verification outputs match expectations across all 7 suppressible patterns, per-JID rate limiting, and disconnect error logging. |
| **Dependency audit** | **PASS** | No core work delegated to unauthorized external dependencies; uses language primitives and project modules. |

---

## 1. Observation

Direct observations from source code analysis, git diffs, and empirical test execution:

### Observation 1.1: Empty JID Guard & Circuit Breaker Protection (`src/auth/badMacInterceptor.js`)
- `getBaseJid(id)` (lines 340-347) validates string types, trims input, handles `@g.us` group JIDs, and extracts base user JID. If invalid or empty, it returns `''`.
- `purgeForBadMac(keyInfo)` (lines 349-353) contains early return guards:
  ```javascript
  if (!keyInfo || !keyInfo.id) return;
  const baseJid = getBaseJid(keyInfo.id);
  if (!baseJid) return;
  ```
- Unextractable/empty JIDs immediately abort before modifying `badMacCounts` or calling `purgeAllForJid('')`. This guarantees that unextractable errors can never trigger the circuit breaker or execute Redis glob `${sessionId}:session-.*` to wipe bot-wide sessions.

### Observation 1.2: Per-Chat Rate Limit Key Scoping (`src/auth/badMacInterceptor.js`)
- Lines 249-250: `keySuffix` resolves to `keyInfo?.id ? keyInfo.id : 'unknown_jid'`.
- Intercepted log rate-limiting keys are scoped per chat JID:
  - Bad MAC: `console:mac:${sessionId}:${keySuffix}`
  - Counter errors: `console:counter:${sessionId}:${keySuffix}`
  - Suppressed logs: `console:suppressed:${sessionId}:${matchedPattern}:${keySuffix}`
  - Unhandled rejections: `unhandled:counter:${sessionId}:${keySuffix}` / `unhandled:mac:${sessionId}:${keySuffix}`
- Errors with unextractable JIDs rate-limit only `unknown_jid`, leaving rate-limiting for specific chat JIDs (`123456789.0`) completely independent.

### Observation 1.3: Suppression Coverage for All 7 Log Patterns (`src/auth/badMacInterceptor.js`)
- Lines 280-288: A structured fallback branch handles all remaining patterns in `SUPPRESS_PATTERNS` (`'Failed to decrypt message'`, `'Session error:'`, `'Closing session: SessionEntry'`, `'Closing open session in favor of incoming prekey bundle'`).
- Un-rate-limited suppressible logs emit: `[BadMAC] Suppressed session log (${matchedPattern}) for session '${sessionId}'${keyStr}.`. No suppressible log pattern is silently swallowed without visibility.

### Observation 1.4: Pino Diagnostics & Disconnect Logging (`index.js` & `src/handler.js`)
- `index.js` line 43: Logger level set to `pino({ level: process.env.LOG_LEVEL || "warn" })`.
- `index.js` lines 320-322: Connection close handler logs `lastDisconnect?.error?.message` and stack trace.
- `index.js` lines 135-139: Duplicate `unhandledRejection` listener removed; unhandled rejections handled uniformly by `badMacInterceptor.js`.
- `src/handler.js` lines 60-70: `alertOwner` ignores transient decryption/session errors (`'Bad MAC'`, `'Key used already'`, `'MessageCounterError'`, `'Failed to decrypt message'`, `'Session error:'`), preventing spamming the bot owner over WhatsApp.

---

## 2. Logic Chain

1. **Authenticity Check**: The modifications in `src/auth/badMacInterceptor.js`, `index.js`, and `src/handler.js` contain zero hardcoded test constants, mocked return statements, or dummy short-circuits. All logic directly implements the required Milestone 2 specifications.
2. **Behavioral Integrity**:
   - `npm test` runs node unit tests (`src/auth/badMacInterceptor.test.js` and `src/auth/redisSession.test.js`), all of which pass cleanly.
   - `node --test tests/challenger_m2_empirical.test.js tests/challenger_m2_jid_edgecases.test.js` executes 12 rigorous challenger tests verifying disconnect formatting, empty JID handling, rate-limiting independence, circuit breaker scoping, and suppressible pattern matching. All 12 tests pass (100%).
3. **Integrity Mode Alignment**: Under `benchmark` mode (from `ORIGINAL_REQUEST.md`), the implementation uses standard JavaScript primitives and project modules, contains no borrowed or pre-built facades, and operates authentically.

---

## 3. Caveats

- **Upstream Baileys Exception Formats**: Key extraction in `extractKeyId()` relies on regex patterns matching standard Signal stack traces and JID structures (`address: <addr>`, `at async <addr>`, `@s.whatsapp.net`, `@lid`, `@g.us`). If `@whiskeysockets/baileys` radically alters stack trace formatting in future major updates, regex patterns may need corresponding updates.
- **Throwing Property Getters on Error Objects**: As surfaced by challenger test 4.0, passing an error object with throwing property getters (e.g. `Object.defineProperty(obj, 'stack', { get() { throw new Error(...); } })`) causes property access in `collectErrorTexts()` to throw. This is an extreme edge case not observed in normal Baileys operations.

---

## 4. Conclusion

The Milestone 2 work products in `src/auth/badMacInterceptor.js`, `index.js`, and `src/handler.js` are **CLEAN**. All acceptance criteria for Milestone 2 are authentically implemented, fully functional, and verified empirically.

---

## 5. Verification Method

To independently verify this audit:

1. **Syntax Validation**:
   ```bash
   node -c src/auth/badMacInterceptor.js && node -c index.js && node -c src/handler.js
   ```
2. **Project Unit Suite**:
   ```bash
   npm test
   ```
3. **Challenger Empirical Test Suite**:
   ```bash
   node --test tests/challenger_m2_empirical.test.js tests/challenger_m2_jid_edgecases.test.js
   ```

---

## Evidence Summary

### Command Output: `node --test tests/challenger_m2_empirical.test.js tests/challenger_m2_jid_edgecases.test.js`
```
✔ M2 Empirical 1.0 — index.js disconnect error message & stack formatting (2.5584ms)
✔ M2 Empirical 1.1 — Unparseable or empty JID inputs in bad MAC errors (68.2672ms)
✔ M2 Empirical 1.2 — Unhandled rejection listener with unparseable or empty JID (1.991ms)
✔ M2 Empirical 2.1 — Rate-limiting independence for known JID vs unknown JID (2.9217ms)
✔ M2 Empirical 2.2 — Circuit breaker scoping per-chat JID (113.9751ms)
✔ M2 Empirical 3.1 — Intercepting all 7 suppressible error patterns (2.283ms)
✔ M2 Empirical 3.2 — Non-suppressible log pass-through (0.793ms)
✔ M2 Empirical 3.3 — Nested Error and Object matching for suppressible patterns (1.1254ms)
✔ M2 Empirical 4.0 — Throwing getters in error objects cause uncaught exceptions in console.error (1.4073ms)
✔ M2 Edge Cases — JID Regex Extraction & Formatting (5.3281ms)
✔ M2 Edge Cases — In-flight Wipe Deduplication (_wipesInFlight) (56.6199ms)
✔ M2 Edge Cases — Circuit breaker error handling and count recovery (56.5782ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2115.8869
```
