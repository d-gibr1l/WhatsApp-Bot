# Changes Report — Worker 2 (Iteration 2 Auth & Interceptor Fixes)

## Summary of Changes

### 1. `src/auth/redisSession.js`
- **JID Base Extraction (`purgeAllKeysForJid`, line 456)**:
  - **Issue**: `jid.split(':')[0].split('.')[0]` on user JID `"12345@s.whatsapp.net"` split on `.` within `@s.whatsapp.net`, yielding `base = "12345@s"`. SCAN patterns like `unknown:session-12345@s.*` failed to match `unknown:session-12345.*`, resulting in zero keys purged.
  - **Fix**: Extracted domain suffix (`@s.whatsapp.net`, `@lid`, etc.) prior to splitting on `:` or `.`:
    ```javascript
    const userJid = isGroup ? jid : jid.split('@')[0];
    const base = escapeGlob(isGroup ? jid : userJid.split(':')[0].split('.')[0]);
    ```
- **Data Corruption Protection in `bufferReviver` (lines 139-154)**:
  - **Issue**: Loose regex `/^\d+$/` misidentified plain JS objects with non-contiguous numeric string keys (such as pre-key maps `{ "1": { keyId: 1 }, "2": { keyId: 2 } }`) as Buffer arrays, coercing missing zero-based index entries to `0` and corrupting pre-keys into `<Buffer 00 00>`.
  - **Fix**: Restricted revive condition to objects with strictly contiguous zero-indexed keys (`k === String(i)`) and byte values (`typeof value[k] === 'number' && Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 255`):
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

### 2. `src/auth/badMacInterceptor.js`
- **Primitive Error & String Rejection Handling (`_unhandledHandler`)**:
  - **Issue**: Primitive string rejections (e.g. `Promise.reject("Bad MAC...")`) or non-Error objects yielded `msg = ''`, causing `isBadMac` to evaluate to `false` and escalating/re-throwing the rejection as an uncaught exception.
  - **Fix**: Enhanced message extraction to extract string representations for primitive strings and non-Error objects:
    ```javascript
    const msg =
      typeof reason === 'string'
        ? reason
        : reason instanceof Error
        ? (reason.message ?? '') + '\n' + (reason.stack ?? '')
        : reason
        ? String(reason)
        : '';
    const isCounter =
      (reason && reason.name === 'MessageCounterError') ||
      msg.includes('Key used already') ||
      msg.includes('MessageCounterError');
    const isBadMac = msg.includes('Bad MAC');
    ```
- **Console Log String Parameters & Key ID Extraction**:
  - **Issue**: `handleInterceptedLog` failed to pass log string arguments to `extractKeyId` when no `Error` or plain object parameter was present in console log arguments.
  - **Fix**: Fall back to using the concatenated `text` string as `targetArg` if no `Error` or object parameter is present. Updated `extractKeyId` to handle primitive non-null values by appending `String(errOrObj)`.

---

## Verification Executed
1. `node -c src/auth/redisSession.js` — PASSED
2. `node -c src/auth/badMacInterceptor.js` — PASSED
3. `node -c index.js` — PASSED
4. `node -e "import('./index.js').catch(console.error)"` — PASSED
