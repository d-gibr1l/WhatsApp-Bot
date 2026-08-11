# Handoff Report: WhatsApp Bot Session Error & badMacInterceptor Analysis

**Work Product**: Investigation of `badMacInterceptor.js`, session error propagation, process crashes, and connection handling in `src/auth/` and `index.js`.  
**Agent**: Survey Explorer 1  
**Working Directory**: `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_survey_1`  
**Date**: 2026-08-10  

---

## 1. Observation

### Observation 1.1: `_unhandledHandler` in `src/auth/badMacInterceptor.js` (lines 308–323)
In `src/auth/badMacInterceptor.js`:
```javascript
308:   _unhandledHandler = async (reason) => {
309:     try {
310:       const errorTexts = collectErrorTexts(reason);
311:       const msg = errorTexts.join('\n');
312:       const isCounter =
313:         (reason && reason.name === 'MessageCounterError') ||
314:         msg.includes('Key used already') ||
315:         msg.includes('MessageCounterError');
316:       const isBadMac = msg.includes('Bad MAC');
317: 
318:       if (!isCounter && !isBadMac) {
319:         _originalConsoleError('Unhandled Rejection:', reason);
320:         escalateRejection(reason);
321:         return;
322:       }
```
Direct observation: `_unhandledHandler` hardcodes checks for `isCounter` and `isBadMac`. Rejections with `SessionError: No session record` or `SessionError: No matching sessions found for message` result in `!isCounter && !isBadMac === true`.

### Observation 1.2: Escalation via `setImmediate` in `src/auth/badMacInterceptor.js` (lines 202–207)
```javascript
202: function escalateRejection(reason) {
203:   if (process.listenerCount('unhandledRejection') > 1) return;
204:   setImmediate(() => {
205:     throw reason;
206:   });
207: }
```
Direct observation: Calling `escalateRejection(reason)` schedules `throw reason;` on `setImmediate`. Thrown errors inside `setImmediate` become uncaught exceptions on the Node.js event loop, causing Node.js to exit and trigger container restarts.

### Observation 1.3: Omission in `SUPPRESS_PATTERNS` in `src/auth/badMacInterceptor.js` (lines 68–76)
```javascript
68: const SUPPRESS_PATTERNS = [
69:   'Bad MAC',
70:   'Key used already',
71:   'MessageCounterError',
72:   'Failed to decrypt message',
73:   'Session error:',
74:   'Closing session: SessionEntry',
75:   'Closing open session in favor of incoming prekey bundle',
76: ];
```
Direct observation: `SUPPRESS_PATTERNS` lists `'Session error:'`, but does not explicitly contain `'No session record'` or `'No matching sessions found for message'`. Furthermore, Layer 2 (`_unhandledHandler`) does not reference `SUPPRESS_PATTERNS` at all.

### Observation 1.4: Process Unhandled Rejection Registration in `index.js` (line 48 & 137)
In `index.js`:
```javascript
48: installBadMacInterceptor(purgeCorruptKey, getSessionId, purgeAllKeysForJid);
...
137: // Note: unhandledRejection listener is managed uniformly by installBadMacInterceptor.
```
Direct observation: `index.js` delegates process `unhandledRejection` handling solely to `installBadMacInterceptor`. No secondary rejection handler intercepts escalated rejections before process exit.

---

## 2. Logic Chain

1. **Premise 1 (Observation 1.1)**: `_unhandledHandler` in `src/auth/badMacInterceptor.js` evaluates `if (!isCounter && !isBadMac)` to decide whether an unhandled promise rejection should be escalated.
2. **Premise 2 (Observation 1.1 & 1.3)**: `SessionError: No session record` and `SessionError: No matching sessions found for message` contain neither `'MessageCounterError'` nor `'Bad MAC'`. Therefore, for these errors, `!isCounter && !isBadMac` is `true`.
3. **Premise 3 (Observation 1.2)**: When `!isCounter && !isBadMac` is `true`, `_unhandledHandler` invokes `escalateRejection(reason)`, which executes `setImmediate(() => { throw reason; })`.
4. **Premise 4 (Observation 1.4)**: Thrown exceptions in `setImmediate` cannot be caught by async promise handlers and bubble up as uncaught exceptions, causing Node.js process termination.
5. **Conclusion**: Unhandled promise rejections originating from Baileys/libsignal session decryption errors (`No session record`, `No matching sessions found for message`) bypass suppression in `badMacInterceptor.js` and cause the Node.js process to crash and restart the container.

---

## 3. Caveats

- **Network-level disconnects**: Physical network dropouts (socket hangup, 408 query timeout) were analyzed via `index.js` static code paths. Runtime socket packet simulation was not performed.
- **Third-party library internals**: Error message strings (`SessionError: No session record`, `SessionError: No matching sessions found for message`) originate from `@whiskeysockets/libsignal-node` / `@whiskeysockets/baileys`. Any upstream changes in string formatting in future library versions must be monitored.

---

## 4. Conclusion

The root cause of container restarts due to `SessionError: No session record` and `SessionError: No matching sessions found for message` is located in `src/auth/badMacInterceptor.js` (lines 308–323 and lines 202–207). 

`badMacInterceptor.js` must be updated to:
1. Include explicit patterns `'No session record'`, `'No matching sessions found'`, and `'SessionError'` in `SUPPRESS_PATTERNS` (lines 68–76).
2. Update `_unhandledHandler` (lines 308–323) to catch session errors (`isSessionError` or `isSuppressible(reason)`) and suppress/rate-limit them instead of escalating to process exit via `escalateRejection`.

---

## 5. Verification Method

### Step 1: Code Inspection
Inspect `src/auth/badMacInterceptor.js`:
- Confirm `SUPPRESS_PATTERNS` contains `'No session record'` and `'No matching sessions found'`.
- Confirm `_unhandledHandler` checks for session errors and suppresses them without calling `escalateRejection`.

### Step 2: Unit Test Execution
Run the unit test suite to ensure existing tests pass and new suppression test cases pass:
```bash
npm test
```
Or execute Node test runner directly:
```bash
node --test src/auth/badMacInterceptor.test.js src/auth/redisSession.test.js
```

### Step 3: Empirical Rejection Test
Simulate unhandled promise rejections for session errors:
```javascript
const err1 = new Error('SessionError: No session record');
const err2 = new Error('SessionError: No matching sessions found for message');
process.emit('unhandledRejection', err1);
process.emit('unhandledRejection', err2);
```
Verify that the process remains running, logs a rate-limited `[BadMAC] Suppressed unhandled SessionError` message, and does **not** crash.
