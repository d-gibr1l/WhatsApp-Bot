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
 *   offending key from the L1 cache + Redis so the next decrypt gets a fresh key.
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
const PURGE_DEDUP_MS = 2_000; // collapse duplicate purges of the same key within 2s

// Map<jid, {count: number, windowStart: number}>
const badMacCounts = new Map();

// Periodically prune the maps so they don't grow unbounded. The timer is tied
// to the interceptor's lifetime rather than to module load: uninstall clears
// it, so install has to be able to start it again — otherwise an
// uninstall/reinstall cycle leaves the maps growing with nothing to prune them.
let _pruneTimer = null;

function startPruneTimer() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, time] of lastLogTime.entries()) {
      if (now - time > RATE_LIMIT_MS * 10) {
        lastLogTime.delete(key);
      }
    }
    for (const [jid, data] of badMacCounts.entries()) {
      if (now - data.windowStart > 60_000) {
        badMacCounts.delete(jid);
      }
    }
    for (const [id, time] of _recentlyPurged.entries()) {
      if (now - time > PURGE_DEDUP_MS) {
        _recentlyPurged.delete(id);
      }
    }
  }, 5 * 60_000);
  // Keeps the timer from holding the process open on its own.
  _pruneTimer.unref?.();
}

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
  if (args.length === 0) return false;

  let hasKeyword = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg === 'string') {
      if (
        arg.includes('MAC') ||
        arg.includes('Session') ||
        arg.includes('session') ||
        arg.includes('prekey') ||
        arg.includes('failed') ||
        arg.includes('Failed') ||
        arg.includes('Counter') ||
        arg.includes('Key used already') ||
        arg.includes('decrypt')
      ) {
        hasKeyword = true;
        break;
      }
    } else if (arg && typeof arg === 'object') {
      const texts = collectErrorTexts(arg);
      const msg = texts.join(' ');
      if (
        msg.includes('MAC') ||
        msg.includes('Session') ||
        msg.includes('session') ||
        msg.includes('prekey') ||
        msg.includes('failed') ||
        msg.includes('Failed') ||
        msg.includes('Counter') ||
        msg.includes('Key used already') ||
        msg.includes('decrypt')
      ) {
        hasKeyword = true;
        break;
      }
    }
  }

  if (!hasKeyword) return false;

  const text = args
    .map((a) => (typeof a === 'string' ? a : collectErrorTexts(a).join(' ')))
    .join(' ');
  return SUPPRESS_PATTERNS.some((p) => text.includes(p));
}

// ─── Key ID extraction ────────────────────────────────────────────────────────

// A libsignal ProtocolAddress renders as `<id>.<deviceId>`, and that exact
// string is what Baileys uses as the `session` key id. Anything handed to
// purgeCorruptKey() must be in this shape or it will delete nothing.
const SIGNAL_ADDRESS_RE = /^[\w-]+\.\d+$/;

/**
 * Attempt to extract a purgeable key reference from a libsignal error stack.
 *
 * libsignal embeds the sender address in the async call chain:
 *   "at async 59335526904016.73 [as awaitable]"
 *
 * Two kinds of result come back, and they are NOT interchangeable:
 *
 *   exact: true  → `id` is a real key id in Baileys' keystore namespace, so
 *                  purgeCorruptKey(type, id) will hit an existing key.
 *   exact: false → all we recovered is a JID. The corresponding key id cannot
 *                  be reconstructed from the stack (sender-key ids embed the
 *                  sending user; lid→address encoding is version-dependent),
 *                  so only a prefix wipe via purgeAllForJid() can act on it.
 *
 * @param {Error} err
 * @returns {{ type: string, id: string, exact: boolean } | null}
 */
function collectErrorTexts(obj, visited = new Set(), depth = 0) {
  if (!obj || depth > 5 || visited.has(obj)) return [];
  if (typeof obj === 'string') return [obj];
  if (typeof obj !== 'object') return [String(obj)];

  visited.add(obj);
  const parts = [];

  if (obj.stack) parts.push(String(obj.stack));
  if (obj.message) parts.push(String(obj.message));
  if (obj.jid) parts.push(String(obj.jid));
  if (obj.chatId) parts.push(String(obj.chatId));
  if (obj.sender) parts.push(String(obj.sender));
  if (obj.remoteJid) parts.push(String(obj.remoteJid));
  if (obj.id && typeof obj.id === 'string') parts.push(obj.id);

  const nestedKeys = ['cause', 'reason', 'err', 'error', 'originalError'];
  for (const key of nestedKeys) {
    if (obj[key]) {
      parts.push(...collectErrorTexts(obj[key], visited, depth + 1));
    }
  }

  return parts;
}

/**
 * Attempt to extract a purgeable key reference from a libsignal error stack.
 *
 * libsignal embeds the sender address in the async call chain:
 *   "at async 59335526904016.73 [as awaitable]"
 *
 * Two kinds of result come back, and they are NOT interchangeable:
 *
 *   exact: true  → `id` is a real key id in Baileys' keystore namespace, so
 *                  purgeCorruptKey(type, id) will hit an existing key.
 *   exact: false → all we recovered is a JID. The corresponding key id cannot
 *                  be reconstructed from the stack (sender-key ids embed the
 *                  sending user; lid→address encoding is version-dependent),
 *                  so only a prefix wipe via purgeAllForJid() can act on it.
 *
 * @param {Error} err
 * @returns {{ type: string, id: string, exact: boolean } | null}
 */
function extractKeyId(errOrObj) {
  if (!errOrObj) return null;

  const stackParts = collectErrorTexts(errOrObj);
  const stack = stackParts.join('\n');
  if (!stack) return null;

  // Pattern 1: "at async <address> [as awaitable]"  ← most reliable
  const queueMatch = stack.match(/at async ([\w.@:+-]+)\s+\[as awaitable\]/);
  if (queueMatch && SIGNAL_ADDRESS_RE.test(queueMatch[1])) {
    return { type: 'session', id: queueMatch[1], exact: true };
  }

  // Pattern 2: "address: <address>"
  const addrMatch = stack.match(/address:\s*([\w.@:+-]+)/);
  if (addrMatch && SIGNAL_ADDRESS_RE.test(addrMatch[1])) {
    return { type: 'session', id: addrMatch[1], exact: true };
  }

  // Pattern 3: a full user JID, phone-number or linked-device. Normalise it
  // into the signal address form the keystore actually uses — a raw JID is not
  // a key id:
  //   "594…@s.whatsapp.net"     → "594….0"
  //   "594…:73@s.whatsapp.net"  → "594….73"
  //   "594…@s.whatsapp.net.73"  → "594….73"
  //
  // @lid is folded in here deliberately. jidDecode() strips any "_agent" and
  // keeps the bare user, and jidToSignalProtocolAddress() then builds
  // ProtocolAddress(user, device) — so a lid address is encoded identically to
  // a phone-number one. The two are distinguished only by `domainType`, which
  // is not part of the signal address. (Verified against Baileys 6.7.21.)
  const userJid = stack.match(/(\d+)(?::(\d+))?@(?:s\.whatsapp\.net|lid)(?:\.(\d+))?/);
  if (userJid) {
    const device = userJid[2] ?? userJid[3] ?? '0';
    return { type: 'session', id: `${userJid[1]}.${device}`, exact: true };
  }

  // Pattern 4: group JID. sender-key ids are "<group>::<user>::<device>" and
  // the sending user is not recoverable here, so this is prefix-only.
  const groupMatch = stack.match(/(\d+@g\.us)/);
  if (groupMatch) return { type: 'sender-key', id: groupMatch[1], exact: false };

  return null;
}

// ─── Unhandled rejection escalation ──────────────────────────────────────────

// Node disables its default crash-on-unhandled-rejection behaviour as soon as
// an 'unhandledRejection' listener exists. Our listener therefore has to hand
// anything it does not recognise back to that default, or this module silently
// swallows every unhandled rejection in the process.
function escalateRejection(reason) {
  // The interceptor's own listener is already counted, so > 1 means at least
  // one other listener exists — it owns the default behaviour, so escalating
  // here would double-report.
  if (process.listenerCount('unhandledRejection') > 1) return;

  // Rethrowing outside the handler surfaces the value as an uncaughtException,
  // which is exactly what --unhandled-rejections=throw (the Node default) does:
  // the app's own uncaughtException handler sees it, or the process prints the
  // stack and exits non-zero.
  setImmediate(() => {
    throw reason;
  });
}

// ─── Interceptor installation ─────────────────────────────────────────────────

let _installed = false;
let _originalConsoleError = null;
let _originalConsoleLog = null;
let _unhandledHandler = null;
const _recentlyPurged = new Map();

// Map<jid, Promise> — full wipes currently running. Concurrent Bad MACs for a
// JID join the in-flight wipe instead of starting a competing one. Entries
// remove themselves when the wipe settles, so this needs no pruning.
const _wipesInFlight = new Map();

export function uninstallBadMacInterceptor() {
  if (!_installed) return;
  if (_originalConsoleError) console.error = _originalConsoleError;
  if (_originalConsoleLog) console.log = _originalConsoleLog;
  if (_unhandledHandler) process.off('unhandledRejection', _unhandledHandler);
  clearInterval(_pruneTimer);
  _pruneTimer = null;
  _installed = false;
  lastLogTime.clear();
  badMacCounts.clear();
  _recentlyPurged.clear();
  _wipesInFlight.clear();
}

/**
 * Install the Bad MAC interceptor.
 *
 * Safe to call multiple times — only installs once.
 *
 * @param {Function} purgeCorruptKey - async (type: string, id: string) => void
 * @param {Function} getSessionId    - () => string
 * @param {Function} [purgeAllForJid] - async (jid: string) => void
 */
export function installBadMacInterceptor(purgeCorruptKey, getSessionId, purgeAllForJid) {
  if (_installed) return;
  _installed = true;
  startPruneTimer();

  // ── Layer 1: console.error / console.log shim ──────────────────────────────
  // Silences Bad MAC / decrypt error messages that Baileys and libsignal print
  // directly to console.error or console.log (bypassing our pino "silent" logger).
  _originalConsoleError = console.error.bind(console);
  _originalConsoleLog = console.log.bind(console);

  console.error = (...args) => {
    if (!isSuppressible(...args)) {
      _originalConsoleError(...args);
      return;
    }
    handleInterceptedLog(_originalConsoleError, args);
  };

  console.log = (...args) => {
    if (!isSuppressible(...args)) {
      _originalConsoleLog(...args);
      return;
    }
    // For console.log, we just suppress it completely unless it's a Bad MAC that needs purging
    handleInterceptedLog(_originalConsoleLog, args, true);
  };

  function handleInterceptedLog(originalLogFn, args, isLog = false) {
    const sessionId = getSessionId();
    const text = args
      .map((a) => (typeof a === 'string' ? a : collectErrorTexts(a).join(' ')))
      .join(' ');

    if (text.includes('Bad MAC')) {
      let targetArg = args.find((a) => a instanceof Error);
      if (!targetArg) {
        targetArg = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
      }
      if (!targetArg) {
        targetArg = text;
      }
      const keyInfo = targetArg ? extractKeyId(targetArg) : null;

      if (!isLog && !isRateLimited(`console:mac:${sessionId}`)) {
        const keyStr = keyInfo ? ` (key: ${keyInfo.id})` : '';
        originalLogFn(
          `[BadMAC] Decryption failure for session '${sessionId}'${keyStr}. ` +
          `Baileys is self-healing — message dropped gracefully.`
        );
      }

      if (keyInfo) {
        purgeForBadMac(keyInfo).catch(() => {});
      }
      return;
    }

    if (text.includes('Key used already') || text.includes('MessageCounterError')) {
      if (!isLog && !isRateLimited(`console:counter:${sessionId}`)) {
        originalLogFn(
          `[BadMAC] Replay protection for session '${sessionId}' — message dropped.`
        );
      }
      return;
    }

    // "Failed to decrypt", "Session error:", "Closing session/open session" —
    // completely suppressed.
  }

  // ── Layer 2: unhandledRejection listener ───────────────────────────────────
  // Catches Bad MAC / counter errors that escape Baileys' internal catch blocks.
  _unhandledHandler = async (reason) => {
    try {
      const errorTexts = collectErrorTexts(reason);
      const msg = errorTexts.join('\n');
      const isCounter =
        (reason && reason.name === 'MessageCounterError') ||
        msg.includes('Key used already') ||
        msg.includes('MessageCounterError');
      const isBadMac = msg.includes('Bad MAC');

      // Not ours — hand it back to Node's default behaviour rather than
      // swallowing an unrelated failure.
      if (!isCounter && !isBadMac) {
        escalateRejection(reason);
        return;
      }

      const sessionId = getSessionId();

      // Replay protection — drop silently
      if (isCounter) {
        if (!isRateLimited(`unhandled:counter:${sessionId}`)) {
          _originalConsoleError(
            `[BadMAC] MessageCounterError (unhandled rejection) for session '${sessionId}' — dropped.`
          );
        }
        return;
      }

      // Bad MAC — purge the offending key
      if (!isRateLimited(`unhandled:mac:${sessionId}`)) {
        _originalConsoleError(
          `[BadMAC] Unhandled Bad MAC for session '${sessionId}'. Purging key.`
        );
      }

      const keyInfo = extractKeyId(reason);
      if (!keyInfo) return; // No key ID — Baileys will self-heal via prekey bundle

      try {
        await purgeForBadMac(keyInfo);
      } catch (err) {
        _originalConsoleError(`[BadMAC] Purge failed for ${keyInfo.type}:${keyInfo.id}:`, err.message);
      }
    } catch (handlerErr) {
      _originalConsoleError('[BadMAC] Exception in unhandledRejection listener:', handlerErr);
    }
  };
  process.on('unhandledRejection', _unhandledHandler);

  function getBaseJid(id) {
    if (!id) return '';
    if (id.endsWith('@g.us')) return id;
    return id.split('@')[0].split(':')[0].split('.')[0];
  }

  async function purgeForBadMac(keyInfo) {
    const now = Date.now();
    const baseJid = getBaseJid(keyInfo.id);

    // A full wipe for this JID is already running. Join it rather than queueing
    // a competing one, and don't count the failure — the wipe about to finish
    // already covers it.
    const inFlight = _wipesInFlight.get(baseJid);
    if (inFlight) return inFlight;

    // Always count the failure toward the circuit breaker by base JID
    let stats = badMacCounts.get(baseJid) || { count: 0, windowStart: now };
    if (now - stats.windowStart > 60_000) {
      stats = { count: 0, windowStart: now }; // reset expired window
    }
    stats.count++;
    badMacCounts.set(baseJid, stats);

    // Circuit Breaker: too many failures for one JID → wipe all its keys.
    // This runs regardless of the dedup window.
    if (purgeAllForJid && stats.count >= 3) {
      _originalConsoleError(`[BadMAC] Circuit Breaker: JID ${baseJid} hit ${stats.count} bad MACs in 60s. Wiping all session keys.`);

      // Reset *before* awaiting. Everything up to the first await runs
      // atomically, so a concurrent caller must never observe a count that is
      // still over the threshold while the wipe is in flight.
      badMacCounts.delete(baseJid);
      for (const id of _recentlyPurged.keys()) {
        if (id === baseJid || getBaseJid(id) === baseJid) {
          _recentlyPurged.delete(id);
        }
      }

      const wipe = Promise.resolve(purgeAllForJid(baseJid))
        .catch((err) => {
          _originalConsoleError(`[BadMAC] Circuit Breaker wipe failed for JID ${baseJid}:`, err.message);
          const current = badMacCounts.get(baseJid);
          if (!current) {
            badMacCounts.set(baseJid, { count: 3, windowStart: Date.now() });
          } else {
            current.count = Math.max(current.count, 3);
          }
          throw err;
        })
        .finally(() => _wipesInFlight.delete(baseJid));
      _wipesInFlight.set(baseJid, wipe);
      return wipe;
    }

    // Below the breaker threshold: purge just the offending key, but collapse
    // duplicate single-key purges of the same JID within the dedup window.

    // Only an exact key id can be purged individually. For a JID-only match,
    // purgeCorruptKey() would build a key name that matches nothing and report
    // a successful purge, so leave it to the breaker's prefix wipe (the failure
    // has already been counted above) and to Baileys' own prekey self-heal.
    if (!keyInfo.exact) return;

    const last = _recentlyPurged.get(keyInfo.id) ?? 0;
    if (now - last < PURGE_DEDUP_MS) return;
    _recentlyPurged.set(keyInfo.id, now);

    await purgeCorruptKey(keyInfo.type, keyInfo.id);
  }

  console.log('[BadMAC] Interceptor installed — Bad MAC errors will be handled gracefully.');
}
