import crypto from "crypto";

// ── Dashboard auth ──────────────────────────────────────────────────────────
// Minimal session-cookie gate for the Express dashboard API. No new
// dependencies: a random bearer token per login, held in memory, sent back
// as an HttpOnly cookie. Single-process bot (InstanceLock already enforces
// that), so an in-memory session store is fine — a restart just requires
// logging in again.

const COOKIE_NAME = "hooper_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

/**
 * Resolve the dashboard password: use DASHBOARD_PASSWORD if set, otherwise
 * generate a random one for this process and return it so the caller can
 * log it. Login is impossible without knowing this value either way.
 */
export function resolveDashboardPassword(env = process.env) {
  if (env.DASHBOARD_PASSWORD && env.DASHBOARD_PASSWORD.trim()) {
    return { password: env.DASHBOARD_PASSWORD.trim(), generated: false };
  }
  return { password: crypto.randomBytes(18).toString("base64url"), generated: true };
}

export function createDashboardAuth({ password }) {
  const sessions = new Map(); // token -> expiresAt
  const failedAttempts = new Map(); // ip -> { count, lockedUntil }

  function timingSafeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
      // Still run a compare of equal length to keep timing roughly constant.
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

  function clearFailures(ip) {
    failedAttempts.delete(ip);
  }

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

  function destroySession(token) {
    if (token) sessions.delete(token);
  }

  function parseCookie(cookieHeader, name) {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
  }

  function setCookie(res, token, { secure } = {}) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    const attrs = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAgeSec}`,
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

  function isHttps(req) {
    return req.secure || req.headers["x-forwarded-proto"] === "https";
  }

  const login = (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (isLockedOut(ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
    }
    const { password: given } = req.body || {};
    if (!given || !timingSafeEqual(given, password)) {
      recordFailure(ip);
      return res.status(401).json({ error: "Incorrect password." });
    }
    clearFailures(ip);
    const token = createSession();
    setCookie(res, token, { secure: isHttps(req) });
    return res.json({ success: true });
  };

  const logout = (req, res) => {
    const token = parseCookie(req.headers.cookie, COOKIE_NAME);
    destroySession(token);
    clearCookie(res);
    return res.json({ success: true });
  };

  const requireAuth = (req, res, next) => {
    const token = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Unauthorized. Please log in." });
    }
    next();
  };

  return { login, logout, requireAuth, _sessions: sessions };
}
