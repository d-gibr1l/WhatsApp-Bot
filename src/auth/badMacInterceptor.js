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
 */

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const lastLogTime = new Map();
const RATE_LIMIT_MS = 10_000;          // max 1 log per key per 10s
const PURGE_DEDUP_MS = 2_000;          // collapse duplicate purges of the same key within 2s

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const CIRCUIT_BREAKER_THRESHOLD = 3;   // bad MACs per JID before a full wipe is triggered
const CIRCUIT_BREAKER_WINDOW_MS = 60_000; // sliding window for the threshold count

// ─── Shared module-level state ────────────────────────────────────────────────

const badMacCounts = new Map();
const _recentlyPurged = new Map();
const _wipesInFlight = new Map();

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
      if (now - data.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
        badMacCounts.delete(jid);
      }
    }
    for (const [id, time] of _recentlyPurged.entries()) {
      if (now - time > PURGE_DEDUP_MS) {
        _recentlyPurged.delete(id);
      }
    }
  }, 5 * 60_000);
  _pruneTimer.unref?.();
}

function isRateLimited(key) {
  const last = lastLogTime.get(key) ?? 0;
  if (Date.now() - last < RATE_LIMIT_MS) return true;
  lastLogTime.set(key, Date.now());
  return false;
}

// ─── Suppressible message patterns ───────────────────────────────────────────

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

  // Fast check: inspect plain string args first before doing deep object walks
  const hasQuickKeyword = args.some(a => {
    if (typeof a === 'string') {
      return (
        a.includes('MAC') ||
        a.includes('Session') ||
        a.includes('session') ||
        a.includes('prekey') ||
        a.includes('failed') ||
        a.includes('Failed') ||
        a.includes('Counter') ||
        a.includes('Key used already') ||
        a.includes('decrypt')
      );
    }
    return false;
  });

  const text = args
    .map((a) => (typeof a === 'string' ? a : collectErrorTexts(a).join(' ')))
    .join(' ');

  if (!hasQuickKeyword) {
    const hasKeyword =
      text.includes('MAC') ||
      text.includes('Session') ||
      text.includes('session') ||
      text.includes('prekey') ||
      text.includes('failed') ||
      text.includes('Failed') ||
      text.includes('Counter') ||
      text.includes('Key used already') ||
      text.includes('decrypt');

    if (!hasKeyword) return false;
  }

  return SUPPRESS_PATTERNS.some((p) => text.includes(p));
}

// ─── Key ID extraction ────────────────────────────────────────────────────────

const SIGNAL_ADDRESS_RE = /^[\w-]+\.\d+$/;

function collectErrorTexts(obj, visited = new Set(), depth = 0) {
  if (!obj || depth > 5 || visited.has(obj)) return [];
  if (typeof obj === 'string') return [obj];
  if (typeof obj !== 'object') return [String(obj)];

  visited.add(obj);
  const parts = [];

  const safeAccess = (fn) => {
    try { return fn(); } catch { return undefined; }
  };

  const stack = safeAccess(() => obj.stack);
  if (stack) parts.push(String(stack));

  const message = safeAccess(() => obj.message);
  if (message) parts.push(String(message));

  const jid = safeAccess(() => obj.jid);
  if (jid) parts.push(String(jid));

  const chatId = safeAccess(() => obj.chatId);
  if (chatId) parts.push(String(chatId));

  const sender = safeAccess(() => obj.sender);
  if (sender) parts.push(String(sender));

  const remoteJid = safeAccess(() => obj.remoteJid);
  if (remoteJid) parts.push(String(remoteJid));

  const id = safeAccess(() => obj.id);
  if (id && typeof id === 'string') parts.push(id);

  const nestedKeys = ['cause', 'reason', 'err', 'error', 'originalError'];
  for (const key of nestedKeys) {
    const val = safeAccess(() => obj[key]);
    if (val) {
      parts.push(...collectErrorTexts(val, visited, depth + 1));
    }
  }

  return parts;
}

function extractKeyId(errOrObj) {
  if (!errOrObj) return null;

  const stackParts = collectErrorTexts(errOrObj);
  const stack = stackParts.join('\n');
  if (!stack) return null;

  // Pattern 1: "at async <address> [as awaitable]"
  const queueMatch = stack.match(/at async ([\w.@:+-]+)\s+\[as awaitable\]/);
  if (queueMatch && SIGNAL_ADDRESS_RE.test(queueMatch[1])) {
    return { type: 'session', id: queueMatch[1], exact: true };
  }

  // Pattern 2: "address: <address>"
  const addrMatch = stack.match(/address:\s*([\w.@:+-]+)/);
  if (addrMatch && SIGNAL_ADDRESS_RE.test(addrMatch[1])) {
    return { type: 'session', id: addrMatch[1], exact: true };
  }

  // Pattern 3: user JID
  const userJid = stack.match(/(\d+)(?::(\d+))?@(?:s\.whatsapp\.net|lid)(?:\.(\d+))?/);
  if (userJid) {
    const device = userJid[2] ?? userJid[3] ?? '0';
    return { type: 'session', id: `${userJid[1]}.${device}`, exact: true };
  }

  // Pattern 4: group JID (Updated regex supports legacy hyphenated group JIDs)
  const groupMatch = stack.match(/([\w-]+@g\.us)/);
  if (groupMatch) return { type: 'sender-key', id: groupMatch[1], exact: false };

  return null;
}

function escalateRejection(reason) {
  if (process.listenerCount('unhandledRejection') > 1) return;
  setImmediate(() => {
    throw reason;
  });
}

// ─── Interceptor installation ─────────────────────────────────────────────────

let _installed = false;
let _originalConsoleError = null;
let _originalConsoleLog = null;
let _unhandledHandler = null;

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

export function installBadMacInterceptor(purgeCorruptKey, getSessionId, purgeAllForJid) {
  if (_installed) return;
  _installed = true;
  startPruneTimer();

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
    handleInterceptedLog(_originalConsoleLog, args, true);
  };

  function handleInterceptedLog(originalLogFn, args, isLog = false) {
    const sessionId = getSessionId();
    const text = args
      .map((a) => (typeof a === 'string' ? a : collectErrorTexts(a).join(' ')))
      .join(' ');

    let targetArg = args.find((a) => a instanceof Error);
    if (!targetArg) {
      targetArg = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
    }
    if (!targetArg) {
      targetArg = text;
    }
    const keyInfo = targetArg ? extractKeyId(targetArg) : null;
    const keySuffix = keyInfo?.id ? keyInfo.id : 'unknown_jid';
    const keyStr = keyInfo?.id ? ` (key: ${keyInfo.id})` : '';

    if (text.includes('Bad MAC')) {
      const rateLimitKey = `console:mac:${sessionId}:${keySuffix}`;

      if (!isLog && !isRateLimited(rateLimitKey)) {
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
      const rateLimitKey = `console:counter:${sessionId}:${keySuffix}`;

      if (!isLog && !isRateLimited(rateLimitKey)) {
        originalLogFn(
          `[BadMAC] Replay protection for session '${sessionId}'${keyStr} — message dropped.`
        );
      }
      return;
    }

    const matchedPattern = SUPPRESS_PATTERNS.find((p) => text.includes(p)) || 'Session error';
    const rateLimitKey = `console:suppressed:${sessionId}:${matchedPattern}:${keySuffix}`;

    if (!isLog && !isRateLimited(rateLimitKey)) {
      originalLogFn(
        `[BadMAC] Suppressed session log (${matchedPattern}) for session '${sessionId}'${keyStr}.`
      );
    }
  }

  _unhandledHandler = async (reason) => {
    try {
      const errorTexts = collectErrorTexts(reason);
      const msg = errorTexts.join('\n');
      const isCounter =
        (reason && reason.name === 'MessageCounterError') ||
        msg.includes('Key used already') ||
        msg.includes('MessageCounterError');
      const isBadMac = msg.includes('Bad MAC');

      if (!isCounter && !isBadMac) {
        _originalConsoleError('Unhandled Rejection:', reason);
        escalateRejection(reason);
        return;
      }

      const sessionId = getSessionId();
      const keyInfo = extractKeyId(reason);
      const keySuffix = keyInfo?.id ? keyInfo.id : 'unknown_jid';
      const counterKey = `unhandled:counter:${sessionId}:${keySuffix}`;
      const macKey = `unhandled:mac:${sessionId}:${keySuffix}`;

      if (isCounter) {
        if (!isRateLimited(counterKey)) {
          _originalConsoleError(
            `[BadMAC] MessageCounterError (unhandled rejection) for session '${sessionId}' — dropped.`
          );
        }
        return;
      }

      if (!isRateLimited(macKey)) {
        _originalConsoleError(
          `[BadMAC] Unhandled Bad MAC for session '${sessionId}'. Purging key.`
        );
      }

      if (!keyInfo) return;

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
    if (!id || typeof id !== 'string') return '';
    const trimmed = id.trim();
    if (!trimmed) return '';
    if (trimmed.endsWith('@g.us')) return trimmed;
    const base = trimmed.split('@')[0].split(':')[0].split('.')[0];
    return base || '';
  }

  async function purgeForBadMac(keyInfo) {
    if (!keyInfo || !keyInfo.id) return;
    const baseJid = getBaseJid(keyInfo.id);
    if (!baseJid) return;

    const now = Date.now();

    const inFlight = _wipesInFlight.get(baseJid);
    if (inFlight) return inFlight;

    let stats = badMacCounts.get(baseJid) || { count: 0, windowStart: now };
    if (now - stats.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
      stats = { count: 0, windowStart: now };
    }
    stats.count++;
    badMacCounts.set(baseJid, stats);

    if (purgeAllForJid && stats.count >= CIRCUIT_BREAKER_THRESHOLD) {
      _originalConsoleError(`[BadMAC] Circuit Breaker: JID ${baseJid} hit ${stats.count} bad MACs in ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s. Wiping all session keys.`);

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
            badMacCounts.set(baseJid, { count: CIRCUIT_BREAKER_THRESHOLD, windowStart: Date.now() });
          } else {
            current.count = Math.max(current.count, CIRCUIT_BREAKER_THRESHOLD);
          }
          throw err;
        })
        .finally(() => _wipesInFlight.delete(baseJid));
      _wipesInFlight.set(baseJid, wipe);
      return wipe;
    }

    if (!keyInfo.exact) return;

    const last = _recentlyPurged.get(keyInfo.id) ?? 0;
    if (now - last < PURGE_DEDUP_MS) return;
    _recentlyPurged.set(keyInfo.id, now);

    await purgeCorruptKey(keyInfo.type, keyInfo.id);
  }

  console.log('[BadMAC] Interceptor installed — Bad MAC errors will be handled gracefully.');
}
