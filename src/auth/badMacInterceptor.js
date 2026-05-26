/**
 * badMacInterceptor.js
 *
 * Two-layer suppression of Signal decryption errors:
 *
 * Layer 1 — console.error shim:
 *   Baileys and libsignal log Bad MAC errors directly via console.error,
 *   bypassing our pino logger (which is set to "silent"). The shim intercepts
 *   these calls and drops known-safe messages, replacing the log flood with a
 *   single rate-limited line from us.
 *
 * Layer 2 — unhandledRejection listener:
 *   Some Bad MAC errors escape Baileys' internal catch blocks and surface as
 *   unhandled rejections. The listener calls purgeCorruptKey() to remove the
 *   offending key from L1 + WAL + MongoDB so the next decrypt gets a fresh key.
 *
 * Both layers share the same rate limiter and key-ID extractor.
 *
 * Error types handled:
 *  - "Bad MAC"                        → purge key + rate-limited log
 *  - "MessageCounterError"            → drop silently (replay protection)
 *  - "Key used already"               → drop silently (replay protection)
 *  - "Failed to decrypt message"      → drop (Baileys wrapper, not actionable)
 *  - "Session error:"                 → drop (Baileys wrapper, not actionable)
 *  - "Closing session: SessionEntry"  → drop (Baileys self-heal log)
 *  - "Closing open session"           → drop (Baileys self-heal log)
 */

// ─── Rate limiter ─────────────────────────────────────────────────────────────

// Map<key, lastLogTimestampMs>
const lastLogTime = new Map();
const RATE_LIMIT_MS = 10_000; // max 1 log per key per 10s

function isRateLimited(key) {
  const last = lastLogTime.get(key) ?? 0;
  if (Date.now() - last < RATE_LIMIT_MS) return true;
  lastLogTime.set(key, Date.now());
  return false;
}

// ─── Suppressible message patterns ───────────────────────────────────────────

// These are console.error calls emitted by Baileys / libsignal internals.
// They are NOT crashes — Baileys handles them and we handle them here.
const SUPPRESS_PATTERNS = [
  'Bad MAC',
  'Key used already',
  'MessageCounterError',
  'Failed to decrypt message',
  'Session error:',
  'Closing session: SessionEntry',
  'Closing open session in favor of incoming prekey bundle',
];

function isSuppressible(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  return SUPPRESS_PATTERNS.some((p) => text.includes(p));
}

// ─── Key ID extraction ────────────────────────────────────────────────────────

/**
 * Attempt to extract { type, id } from a libsignal error stack.
 *
 * libsignal embeds the sender address in the async call chain:
 *   "at async 59335526904016.73 [as awaitable]"
 *
 * @param {Error} err
 * @returns {{ type: string, id: string } | null}
 */
function extractKeyId(err) {
  const stack = err?.stack ?? '';

  // Pattern 1: "at async <jid>.<deviceId> [as awaitable]"  ← most reliable
  const queueMatch = stack.match(/at async ([\w.@:+-]+)\s+\[as awaitable\]/);
  if (queueMatch) return { type: 'session', id: queueMatch[1] };

  // Pattern 2: "address: <jid>.<deviceId>"
  const addrMatch = stack.match(/address:\s*([\w.@:+-]+)/);
  if (addrMatch) return { type: 'session', id: addrMatch[1] };

  // Pattern 3: bare JID-like string anywhere in stack
  const jidMatch = stack.match(/([\d]+@s\.whatsapp\.net\.[\d]+)/);
  if (jidMatch) return { type: 'session', id: jidMatch[1] };

  return null;
}

// ─── Interceptor installation ─────────────────────────────────────────────────

let _installed = false;
let _originalConsoleError = null;

/**
 * Install the Bad MAC interceptor.
 *
 * Safe to call multiple times — only installs once.
 *
 * @param {Function} purgeCorruptKey - async (type: string, id: string) => void
 * @param {Function} getSessionId    - () => string
 */
export function installBadMacInterceptor(purgeCorruptKey, getSessionId) {
  if (_installed) return;
  _installed = true;

  // ── Layer 1: console.error shim ────────────────────────────────────────────
  // Silences Bad MAC / decrypt error messages that Baileys and libsignal print
  // directly to console.error (bypassing our pino "silent" logger).
  // Replaced with a single rate-limited line per session per 10 seconds.
  _originalConsoleError = console.error.bind(console);

  console.error = (...args) => {
    if (!isSuppressible(...args)) {
      // Not a known-safe error — pass through unchanged
      _originalConsoleError(...args);
      return;
    }

    // Known-safe error: emit our own rate-limited summary instead of the flood
    const sessionId = getSessionId();
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');

    if (text.includes('Bad MAC')) {
      // Try to extract a key ID from an Error argument for targeted purge
      const errArg = args.find((a) => a instanceof Error);
      const keyInfo = errArg ? extractKeyId(errArg) : null;

      if (!isRateLimited(`console:mac:${sessionId}`)) {
        const keyStr = keyInfo ? ` (key: ${keyInfo.id})` : '';
        _originalConsoleError(
          `[BadMAC] Decryption failure for session '${sessionId}'${keyStr}. ` +
          `Baileys is self-healing — message dropped gracefully.`
        );
      }

      // Attempt a targeted key purge even if rate-limited (purge is safe to call repeatedly)
      if (keyInfo) {
        purgeCorruptKey(keyInfo.type, keyInfo.id).catch(() => {});
      }
      return;
    }

    if (text.includes('Key used already') || text.includes('MessageCounterError')) {
      if (!isRateLimited(`console:counter:${sessionId}`)) {
        _originalConsoleError(
          `[BadMAC] Replay protection for session '${sessionId}' — message dropped (normal in busy groups).`
        );
      }
      return;
    }

    // "Failed to decrypt", "Session error:", "Closing session/open session" —
    // completely suppressed. These are Baileys' own heal/wrapper logs and are
    // already covered by the Bad MAC line above.
  };

  // ── Layer 2: unhandledRejection listener ───────────────────────────────────
  // Catches Bad MAC / counter errors that escape Baileys' internal catch blocks.
  process.on('unhandledRejection', async (reason) => {
    if (!(reason instanceof Error)) return;

    const msg = reason.message ?? '';

    // Replay protection — drop silently
    if (msg.includes('Key used already') || reason.name === 'MessageCounterError') {
      const sessionId = getSessionId();
      if (!isRateLimited(`unhandled:counter:${sessionId}`)) {
        _originalConsoleError(
          `[BadMAC] MessageCounterError (unhandled rejection) for session '${sessionId}' — dropped.`
        );
      }
      return;
    }

    // Bad MAC — purge the offending key
    if (!msg.includes('Bad MAC')) return;

    const sessionId = getSessionId();

    if (!isRateLimited(`unhandled:mac:${sessionId}`)) {
      _originalConsoleError(
        `[BadMAC] Unhandled Bad MAC for session '${sessionId}'. Purging key.`
      );
    }

    const keyInfo = extractKeyId(reason);
    if (!keyInfo) return; // No key ID — Baileys will self-heal via prekey bundle

    try {
      await purgeCorruptKey(keyInfo.type, keyInfo.id);
    } catch (err) {
      _originalConsoleError(`[BadMAC] Purge failed for ${keyInfo.type}:${keyInfo.id}:`, err.message);
    }
  });

  console.log('[BadMAC] Interceptor installed — Bad MAC errors will be handled gracefully.');
}
