/**
 * badMacInterceptor.js
 *
 * Intercepts Signal decryption errors that arrive as unhandled promise
 * rejections and recovers gracefully without crashing the bot.
 *
 * Two error types handled:
 *
 *  1. "Bad MAC" (libsignal Error: Bad MAC)
 *     Cause: The Signal ratchet key stored in MongoDB is stale or corrupt.
 *     Fix:   Purge the specific key from L1 + WAL + MongoDB. The next message
 *            from the same sender will trigger a fresh key exchange.
 *
 *  2. "MessageCounterError: Key used already"
 *     Cause: Replay protection — WhatsApp resent an already-decrypted message.
 *            The local counter already advanced past this message ID.
 *     Fix:   Log once and drop silently. No key purge needed.
 *
 * Rate limiting:
 *   At most one log line per session per 10 seconds to prevent log flooding
 *   during a burst of Bad MAC errors (e.g. after a restart with many queued
 *   messages from a group with a stale sender-key).
 *
 * Key ID extraction:
 *   libsignal error stacks contain the remoteJid or sender ID in the async
 *   call chain. We extract a best-effort key ID from the stack; if extraction
 *   fails we log a warning and skip the purge (safe — next resync will heal).
 */

// ─── Rate limiter state ───────────────────────────────────────────────────────

// Map<sessionId, lastLogTimestampMs>
const lastLogTime = new Map();
const RATE_LIMIT_MS = 10_000; // max 1 log per session per 10s

function isRateLimited(sessionId) {
  const last = lastLogTime.get(sessionId) ?? 0;
  if (Date.now() - last < RATE_LIMIT_MS) return true;
  lastLogTime.set(sessionId, Date.now());
  return false;
}

// ─── Key ID extraction ────────────────────────────────────────────────────────

/**
 * Attempt to extract a { type, id } pair from a libsignal error stack.
 *
 * libsignal errors typically embed the address string in the stack in the form:
 *   "at SessionCipher.decryptWithSessions ... for address: <jid>.<deviceId>"
 * or in the queue job wrapper:
 *   "at async <jid>.<deviceId> [as awaitable]"
 *
 * If we can extract a JID/address, we purge the 'session' key for it.
 * The type 'session' covers the per-device ratchet state — the most common
 * source of Bad MAC errors.
 *
 * @param {Error} err
 * @returns {{ type: string, id: string } | null}
 */
function extractKeyId(err) {
  const stack = err?.stack ?? '';

  // Pattern 1: async queue wrapper — "at async <jid>.<deviceId> [as awaitable]"
  const queueMatch = stack.match(/at async ([\w.@:+-]+)\s+\[as awaitable\]/);
  if (queueMatch) {
    return { type: 'session', id: queueMatch[1] };
  }

  // Pattern 2: "address: <jid>.<deviceId>" in error message or stack
  const addrMatch = stack.match(/address:\s*([\w.@:+-]+)/);
  if (addrMatch) {
    return { type: 'session', id: addrMatch[1] };
  }

  // Pattern 3: last resort — look for a JID-like string anywhere in the stack
  const jidMatch = stack.match(/([\d]+@s\.whatsapp\.net\.[\d]+)/);
  if (jidMatch) {
    return { type: 'session', id: jidMatch[1] };
  }

  return null;
}

// ─── Interceptor installation ─────────────────────────────────────────────────

let _installed = false;

/**
 * Install the Bad MAC interceptor.
 *
 * Must be called once after the Baileys socket is created and wired.
 * Safe to call on reconnects — subsequent calls are no-ops (the process-level
 * listener is only installed once; the session ID and purgeCorruptKey function
 * are updated via the closure references on first install).
 *
 * @param {Function} purgeCorruptKey - async (type: string, id: string) => void
 *   Imported from mongoSession.js
 * @param {Function} getSessionId    - () => string
 *   Returns the current BOT_NUMBER / session ID for rate-limit keying
 */
export function installBadMacInterceptor(purgeCorruptKey, getSessionId) {
  if (_installed) return;
  _installed = true;

  process.on('unhandledRejection', async (reason) => {
    if (!(reason instanceof Error)) return;

    const msg = reason.message ?? '';

    // ── MessageCounterError: replay protection ──────────────────────────────
    // These are normal in high-traffic groups. Log at most once per interval.
    if (msg.includes('Key used already') || reason.name === 'MessageCounterError') {
      const sessionId = getSessionId();
      if (!isRateLimited(sessionId)) {
        console.warn(
          `[BadMAC] MessageCounterError (replay protection) for session '${sessionId}'. ` +
          `This is normal in high-traffic groups — message dropped silently.`
        );
      }
      return; // No purge needed — this is replay protection working correctly
    }

    // ── Bad MAC: corrupt ratchet key ────────────────────────────────────────
    if (!msg.includes('Bad MAC')) return;

    const sessionId = getSessionId();

    if (!isRateLimited(sessionId)) {
      console.warn(
        `[BadMAC] Decryption failure for session '${sessionId}': ${msg}. ` +
        `Attempting key purge and recovery.`
      );
    }

    // Extract the offending key ID from the error stack
    const keyInfo = extractKeyId(reason);
    if (!keyInfo) {
      console.warn(
        `[BadMAC] Could not extract key ID from error stack — skipping purge. ` +
        `The session will self-heal on next key exchange.`
      );
      return;
    }

    // Purge the corrupt key from L1, WAL, and MongoDB
    try {
      await purgeCorruptKey(keyInfo.type, keyInfo.id);
    } catch (err) {
      console.error(`[BadMAC] Purge failed for ${keyInfo.type}:${keyInfo.id}:`, err.message);
    }
  });

  console.log('[BadMAC] Interceptor installed — Bad MAC errors will be handled gracefully.');
}
