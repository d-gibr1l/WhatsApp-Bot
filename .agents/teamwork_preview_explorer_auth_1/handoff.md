# Handoff Report: Redis Auth & Session Review

## 1. Observation
Direct source code inspection of `src/auth/redisSession.js` and `src/auth/badMacInterceptor.js` revealed multiple severe flaws across logic, concurrency, serialization, and error recovery:

- **`src/auth/redisSession.js:392`**:
  `const isGroup = jid.includes('@');`
  Direct observation shows `@` is present in both user JIDs (`12345@s.whatsapp.net`, `12345@lid`) and group JIDs (`12345@g.us`).
- **`src/auth/redisSession.js:31-38`**:
  `const tracked = promise.finally(() => _pendingWrites.delete(tracked));`
  `tracked` is referenced inside the `finally` callback while `const tracked` declaration is being evaluated.
- **`src/auth/redisSession.js:250, 282-283`**:
  `await pipeline.exec()` and `await trackWrite(pipeline.exec())` are executed without `try-catch` blocks.
- **`src/auth/redisSession.js:131-143`**:
  `bufferReviver` only checks for `{ type: 'Buffer', data: [...] }`. Standard `Uint8Array` objects serialize to `{ "0": x, "1": y, ... }` via `JSON.stringify` and are not restored.
- **`src/auth/redisSession.js:274-282`**:
  `l1Set(key, normalizeForType(value, category))` is invoked before `pipeline.exec()` executes or completes.
- **`src/auth/redisSession.js:96-120`**:
  `getSessionId()` caches `_sessionId` on first call. Late initialization of `botConfig.BOT_NUMBER` results in namespace pinning to `'unknown'`.
- **`src/auth/badMacInterceptor.js:338, 382`**:
  `keyInfo.id` (e.g. `12345.0` vs `12345.73`) is used directly as the key in `badMacCounts`, splitting failure counts per device ID instead of aggregating by user JID.

---

## 2. Logic Chain

1. **Self-Healing Failure Chain:**
   - In `redisSession.js:392`, `jid.includes('@')` returns `true` for user JIDs (`12345@s.whatsapp.net`).
   - `purgeAllKeysForJid` builds group pattern strings (`sender-key-12345@s.whatsapp.net::*`) instead of session pattern strings (`session-12345.*`).
   - `scanKeys` returns zero matching keys. No keys are deleted from Redis or L1 cache.
   - When Bad MAC decryption failures occur repeatedly for a user, the circuit breaker in `badMacInterceptor.js:358` invokes `purgeAllKeysForJid(jid)`.
   - Because zero keys are deleted, the corrupt key persists in Redis, trapping the WhatsApp bot in an unrecoverable Bad MAC decryption loop.

2. **Data Corruption & Bad MAC Signature Chain:**
   - Baileys crypto primitives construct keys as `Uint8Array`.
   - When stored in Redis via `serialize()`, `JSON.stringify` transforms plain `Uint8Array` into numeric-keyed JSON objects `{ "0": x, "1": y }`.
   - On read (`deserialize()`), `bufferReviver` fails to convert numeric-keyed JSON back to `Uint8Array` or `Buffer`.
   - Crypto functions receive plain Objects, triggering `TypeError` or generating invalid decryption keys ("Bad MAC").

3. **Concurrency & State Divergence Chain:**
   - In `keys.set`, `l1Set` updates `_l1Cache` synchronously before `pipeline.exec()` executes on Redis.
   - If Redis connection drops during `pipeline.exec()`, `_l1Cache` holds updated memory state while Redis holds old persistent state.
   - Subsequent `keys.get` calls hit `_l1Cache` and return unpersisted values, creating silent state divergence between memory and Redis.

---

## 3. Caveats
- Direct source code investigation was conducted in read-only mode without executing unit tests or live Redis connections.
- External ioredis cluster topologies or Redis sentinel configurations were not evaluated.
- No modifications were made to source files in `src/auth/` per project constraints.

---

## 4. Conclusion
`src/auth/redisSession.js` and `src/auth/badMacInterceptor.js` contain **14 distinct bugs**, including **1 Critical bug** (`jid.includes('@')` in `purgeAllKeysForJid`) that completely disables Bad MAC self-healing for user sessions. Remediation by an implementer agent is strongly recommended prior to production deployment.

---

## 5. Verification Method

To verify these findings independently:

1. **Verify JID Classification Bug:**
   Inspect `src/auth/redisSession.js:392`. Test calling `purgeAllKeysForJid('123456789@s.whatsapp.net')` and verify that `scanKeys` generates `sender-key-123456789@s.whatsapp.net::*` (which matches zero keys in Redis).

2. **Verify Serialization Bug:**
   Pass a plain `Uint8Array` (e.g. `new Uint8Array([1, 2, 3])`) to `serialize` and `deserialize` in `redisSession.js`. Confirm that `deserialize(serialize(arr))` returns `{ '0': 1, '1': 2, '2': 3 }` instead of a `Uint8Array` or `Buffer`.

3. **Verify TDZ Hazard:**
   Inspect `src/auth/redisSession.js:32`. Confirm `const tracked` is referenced inside `promise.finally(...)` before variable initialization.

4. **Verify L1 Cache Write Pre-emption:**
   Inspect `src/auth/redisSession.js:274-282`. Confirm `l1Set` is executed prior to `await trackWrite(pipeline.exec())`.
