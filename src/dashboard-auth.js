import crypto from "crypto";

// ── Dashboard auth ──────────────────────────────────────────────────────────
// Session-cookie gate for the Express dashboard API. No new dependencies:
// a random bearer token per login, held in memory, sent back as an HttpOnly
// cookie. Single-process bot (InstanceLock enforces that), so an in-memory
// session store is fine — a restart just requires logging in again.
//
// The password itself comes from one of:
//   1. DASHBOARD_PASSWORD env var  — fixed, authoritative, can't be changed
//      from the UI.
//   2. a hash persisted in the DB  — set by the operator on first visit
//      ("setup" mode) and changeable from the dashboard afterwards.
// If neither exists the dashboard is in setup mode: the only thing you can
// do is choose a password.

const COOKIE_NAME = "hooper_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, 64);
  } catch {
    return false;
  }
  const expectedBuf = Buffer.from(expected, "hex");
  return (
    derived.length === expectedBuf.length &&
    crypto.timingSafeEqual(derived, expectedBuf)
  );
}

/**
 * @param {object}   opts
 * @param {string?}  opts.envPassword  DASHBOARD_PASSWORD, or null
 * @param {string?}  opts.storedHash   password hash from the DB, or null
 * @param {(hash: string) => Promise<void>} [opts.persistHash]  saves a new hash
 */
export function createDashboardAuth({ envPassword = null, storedHash = null, persistHash } = {}) {
  const sessions = new Map(); // token -> expiresAt
  const failedAttempts = new Map(); // ip -> { count, lockedUntil }
  let currentHash = storedHash || null;

  const needsSetup = () => !envPassword && !currentHash;
  const setStoredHash = (hash) => { currentHash = hash || null; };

  function verifyGivenPassword(given) {
    if (!given) return false;
    if (envPassword) return timingSafeEqualStr(given, envPassword);
    return verifyPassword(given, currentHash);
  }

  function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
      crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  function isLockedOut(ip) {
    const entry = failedAttempts.get(ip);
    if (!entry) return false;
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
    if (entry.lockedUntil && Date.now() >= entry.lockedUntil) failedAttempts.delete(ip);
    return false;
  }

  function recordFailure(ip) {
    const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
      entry.count = 0;
    }
    failedAttempts.set(ip, entry);
  }

  const clearFailures = (ip) => failedAttempts.delete(ip);

  function createSession() {
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  function isValidSession(token) {
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  const destroySession = (token) => { if (token) sessions.delete(token); };

  function parseCookie(cookieHeader, name) {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() === name) {
        return decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
    return null;
  }

  function setCookie(res, token, { secure } = {}) {
    const attrs = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push("Secure");
    res.setHeader("Set-Cookie", attrs.join("; "));
  }

  function clearCookie(res) {
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
  }

  const isHttps = (req) =>
    req.secure || req.headers["x-forwarded-proto"] === "https";
  const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

  // ── handlers ──────────────────────────────────────────────────────────────

  const authState = (req, res) => {
    const token = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (isValidSession(token)) return res.json({ mode: "authed" });
    return res.json({ mode: needsSetup() ? "setup" : "login" });
  };

  const setup = async (req, res) => {
    if (!needsSetup()) {
      return res.status(409).json({ error: "A password is already configured." });
    }
    const { password } = req.body || {};
    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    const hash = hashPassword(password);
    try {
      if (persistHash) await persistHash(hash);
    } catch (e) {
      return res.status(500).json({ error: "Could not save the password." });
    }
    currentHash = hash;
    const token = createSession();
    setCookie(res, token, { secure: isHttps(req) });
    return res.json({ success: true });
  };

  const login = (req, res) => {
    if (needsSetup()) {
      return res.status(409).json({ error: "No password set yet — run first-time setup." });
    }
    const ip = clientIp(req);
    if (isLockedOut(ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
    }
    const { password } = req.body || {};
    if (!verifyGivenPassword(password)) {
      recordFailure(ip);
      return res.status(401).json({ error: "Incorrect password." });
    }
    clearFailures(ip);
    const token = createSession();
    setCookie(res, token, { secure: isHttps(req) });
    return res.json({ success: true });
  };

  const logout = (req, res) => {
    destroySession(parseCookie(req.headers.cookie, COOKIE_NAME));
    clearCookie(res);
    return res.json({ success: true });
  };

  // Requires an existing session (mount behind requireAuth).
  const changePassword = async (req, res) => {
    if (envPassword) {
      return res.status(400).json({
        error: "Password is fixed by DASHBOARD_PASSWORD — change it in the environment.",
      });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyGivenPassword(currentPassword)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    const hash = hashPassword(newPassword);
    try {
      if (persistHash) await persistHash(hash);
    } catch (e) {
      return res.status(500).json({ error: "Could not save the new password." });
    }
    currentHash = hash;
    // Invalidate every other session; keep the caller logged in.
    const keep = parseCookie(req.headers.cookie, COOKIE_NAME);
    for (const t of [...sessions.keys()]) if (t !== keep) sessions.delete(t);
    return res.json({ success: true });
  };

  const requireAuth = (req, res, next) => {
    const token = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Unauthorized. Please log in." });
    }
    next();
  };

  return {
    authState,
    setup,
    login,
    logout,
    changePassword,
    requireAuth,
    needsSetup,
    setStoredHash,
    _sessions: sessions,
  };
}
