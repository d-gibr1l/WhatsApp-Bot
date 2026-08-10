# Handoff Report: Auth & Bad MAC Interceptor Line-by-Line Review

**Agent**: Explorer 2  
**Target Module**: `src/auth/badMacInterceptor.js` and `src/auth/redisSession.js`  
**Date**: 2026-08-03  

---

## 1. Observation

A detailed line-by-line review of `src/auth/badMacInterceptor.js` (391 lines) and `src/auth/redisSession.js` (442 lines) revealed 9 distinct issues in Signal key error interception, cache management, and session state recovery:

1. **`badMacInterceptor.js:358-371` & `redisSession.js:407-429`**: Circuit breaker triggers `purgeAllForJid()` after 3 Bad MACs, which executes `scanKeys` and deletes all `session-*` and `sender-key-*` keys for that JID.
2. **`redisSession.js:243-260`**: `keys.get` fetches missing keys via Redis `pipeline.exec()`. If `purgeCorruptKey` occurs while the pipeline is in flight, line 259 (`l1Set(key, parsed)`) executes upon pipeline return, writing the stale/corrupt key back into `_l1Cache`.
3. **`badMacInterceptor.js:292-334`**: `_unhandledHandler` is an `async` function. The main execution body is not wrapped in `try/catch`. Throwing inside this function produces an unhandled rejection, which re-enters `_unhandledHandler` endlessly.
4. **`redisSession.js:187-217`**: When `readCreds()` fails JSON parsing, it initializes fresh creds (`initAuthCreds()`) but sets `hadPersistedCreds = false`. `checkIntegrity()` checks `if (!hadPersistedCreds) return;`, skipping `_wipeSessionKeys()`. Old `session-*` keys remain in Redis.
5. **`redisSession.js:266-288`**: `keys.set` updates `_l1Cache` synchronously before `pipeline.exec()`. `pipeline.exec()` failures are logged to console but not thrown/rejected, leaving `_l1Cache` and Redis out of sync.
6. **`badMacInterceptor.js:121, 293`**: `extractKeyId` only checks `errOrObj.stack` if `errOrObj instanceof Error`, ignoring `errOrObj.message` or custom properties. `_unhandledHandler` assumes rejections are `instanceof Error`.
7. **`badMacInterceptor.js:80-88, 235-288`**: `isSuppressible` matches generic strings like `'Session error:'`. Unmatched logs fall through to total suppression on line 286.
8. **`badMacInterceptor.js:349`**: `badMacCounts` Map keys failures by full `<user>.<device>` string rather than base JID, breaking multi-device counter aggregation.
9. **`index.js:146` & `redisSession.js:294`**: `sock.ev.on("creds.update", saveCreds)` registers an async function without error handling, producing unhandled rejections if Redis writes fail.

---

## 2. Logic Chain

1. **Session DoS Vulnerability**:
   - *Observation*: `purgeAllForJid` deletes all Signal protocol keys for a JID when `badMacCounts.get(jid).count >= 3`.
   - *Reasoning*: WhatsApp protocol frames can be sent by unauthenticated remote peers. If an attacker sends 3 bad packets, the bot counts them as Bad MACs, wipes the session keys, and forces a session re-key.
2. **L1 Cache Resurrecting Corrupt Keys**:
   - *Observation*: `keys.get` places fetched values into `_l1Cache` on line 259.
   - *Reasoning*: A key purge between pipeline launch and return deletes the key in Redis and L1, but line 259 executes *after* the purge completes, putting the old key back into `_l1Cache`.
3. **Async Rejection Loop**:
   - *Observation*: `_unhandledHandler` is an async process listener without a top-level `try/catch`.
   - *Reasoning*: Rejections inside an async `unhandledRejection` handler trigger a new `unhandledRejection` event, creating an infinite recursive rejection loop.
4. **Corrupted Creds Recovery Failure**:
   - *Observation*: Invalid JSON in creds sets `hadPersistedCreds = false`, causing `checkIntegrity()` to exit without running `_wipeSessionKeys()`.
   - *Reasoning*: New identity keys are used with old session keys, resulting in 100% Bad MAC decryption failures across all active contacts.

---

## 3. Caveats

- Investigation was performed strictly via code examination and static analysis without executing active Redis instances or WhatsApp Web socket connections.
- Dynamic timing behavior of Redis pipeline latency vs Bad MAC interception latency depends on system I/O speed.

---

## 4. Conclusion

`src/auth/badMacInterceptor.js` and `src/auth/redisSession.js` provide useful log suppression and single-key eviction mechanisms, but suffer from significant race conditions (L1 cache resurrection), security risks (unauthenticated session wipe DoS), and resilience flaws (unhandled rejection loops and corrupted creds recovery failures). Addressing these issues will make auth state recovery robust and resilient against attack vectors.

---

## 5. Verification Method

- Run syntax checks:
  ```powershell
  node -c src/auth/badMacInterceptor.js
  node -c src/auth/redisSession.js
  ```
- Inspect line numbers and evidence documented in `.agents/teamwork_preview_explorer_auth_2/analysis.md`.
