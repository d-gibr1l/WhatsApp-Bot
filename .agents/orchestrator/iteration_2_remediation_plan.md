# Iteration 2 Feedback & Remediation Plan

## Summary of Gate 1 Review & Challenger Findings
While Forensic Auditor 1 returned `CLEAN` (no hardcoding or facade implementations), Reviewer 1, Reviewer 2, Challenger 1, and Challenger 2 identified 3 critical logic issues in `src/auth/redisSession.js` and `src/auth/badMacInterceptor.js`:

1. **JID Base Splitting Defect in `purgeAllKeysForJid` (`redisSession.js:456`)**:
   - `const base = escapeGlob(isGroup ? jid : jid.split(':')[0].split('.')[0]);`
   - Passing `12345@s.whatsapp.net` splits on `.` in `@s.whatsapp.net`, yielding `base = "12345@s"`.
   - Redis SCAN searches for `unknown:session-12345@s.*` instead of `unknown:session-12345.*`, resulting in 0 keys purged for user JIDs.
   - **Fix**: Remove `@s.whatsapp.net` / `@lid` domain suffix before splitting on `:` or `.`:
     `const userJid = isGroup ? jid : jid.split('@')[0];`
     `const base = escapeGlob(isGroup ? jid : userJid.split(':')[0].split('.')[0]);`

2. **Data Corruption Defect in `bufferReviver` (`redisSession.js:139-154`)**:
   - `keys.every((k) => /^\d+$/.test(k))` misidentifies plain JS objects/dictionaries with numeric string keys (e.g. pre-key map `{ "1": { keyId: 1 }, "2": { keyId: 2 } }`) as Buffers.
   - Iterates array indices `value[0]`, `value[1]`, which evaluate to `undefined` -> coerced to `0` -> returns `<Buffer 00 00>`, destroying pre-keys and session state objects.
   - **Fix**: Verify that keys are strictly contiguous indices (`k === String(i)`), and every value is an integer byte (`0..255`):
     ```javascript
     const bufferReviver = (keyName, value) => {
       if (value && typeof value === 'object' && !Array.isArray(value)) {
         if (value.type === 'Buffer' && Array.isArray(value.data)) {
           return Buffer.from(value.data);
         }
         const keys = Object.keys(value);
         if (
           keys.length > 0 &&
           keys.every((k, i) => k === String(i) && typeof value[k] === 'number' && Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 255)
         ) {
           const arr = new Uint8Array(keys.length);
           for (let i = 0; i < keys.length; i++) {
             arr[i] = value[i];
           }
           return Buffer.from(arr);
         }
       }
       return value;
     };
     ```

3. **Primitive Error / String Rejection Crash in `badMacInterceptor.js:312`**:
   - `const msg = reason instanceof Error ? (reason.message ?? '') : '';`
   - String rejections (e.g. `Promise.reject("Bad MAC at...")`) yield `msg = ''`, failing `isBadMac` check and triggering `escalateRejection()`, which re-throws and crashes Node.js.
   - Also, `handleInterceptedLog` ignores string log arguments containing Bad MAC stack traces.
   - **Fix**: Check `typeof reason === 'string'` or convert `String(reason)` in `_unhandledHandler` and `extractKeyId`. Ensure primitive error strings are parsed for key extraction.

---

## Action Plan for Worker 2
Worker 2 will implement these 3 exact fixes, run syntax checks and bootup checks, and report results.
