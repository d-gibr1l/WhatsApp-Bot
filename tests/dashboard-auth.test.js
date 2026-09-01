import test from "node:test";
import assert from "node:assert/strict";
import {
  createDashboardAuth,
  hashPassword,
  verifyPassword,
} from "../src/dashboard-auth.js";

// ── password hashing ────────────────────────────────────────────────────

test("hashPassword/verifyPassword: round-trips", () => {
  const h = hashPassword("correct-horse-battery-staple");
  assert.match(h, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword("correct-horse-battery-staple", h), true);
  assert.equal(verifyPassword("wrong", h), false);
});

test("verifyPassword: rejects garbage/empty stored values", () => {
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", "not-a-hash"), false);
});

// ── fake express req/res ────────────────────────────────────────────────

function fakeReq({ body = {}, cookie = null, ip = "1.2.3.4" } = {}) {
  return { body, headers: cookie ? { cookie } : {}, ip, secure: false };
}
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    setHeader(n, v) { this.headers[n] = v; },
  };
}
function cookieFromSetHeader(res) {
  const raw = res.headers["Set-Cookie"];
  const m = raw && raw.match(/^hooper_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
const cookieHeader = (token) => `hooper_session=${encodeURIComponent(token)}`;

// ── setup mode (no password configured) ─────────────────────────────────

test("authState: reports setup when no env password and no stored hash", () => {
  const auth = createDashboardAuth({});
  const res = fakeRes();
  auth.authState(fakeReq(), res);
  assert.deepEqual(res.body, { mode: "setup" });
});

test("setup: sets the password, persists the hash, and logs the user in", async () => {
  let persisted = null;
  const auth = createDashboardAuth({ persistHash: async (h) => { persisted = h; } });
  const res = fakeRes();
  await auth.setup(fakeReq({ body: { password: "a-good-password" } }), res);
  assert.equal(res.body.success, true);
  assert.ok(persisted);
  assert.ok(cookieFromSetHeader(res));
  assert.equal(auth.needsSetup(), false);
});

test("setup: rejects a short password", async () => {
  const auth = createDashboardAuth({});
  const res = fakeRes();
  await auth.setup(fakeReq({ body: { password: "short" } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(auth.needsSetup(), true);
});

test("setup: refused once a password already exists", async () => {
  const auth = createDashboardAuth({ storedHash: hashPassword("already-set-here") });
  const res = fakeRes();
  await auth.setup(fakeReq({ body: { password: "trying-to-reset" } }), res);
  assert.equal(res.statusCode, 409);
});

test("login: refused while still in setup mode", () => {
  const auth = createDashboardAuth({});
  const res = fakeRes();
  auth.login(fakeReq({ body: { password: "anything" } }), res);
  assert.equal(res.statusCode, 409);
});

// ── login against a stored hash ────────────────────────────────────────

test("login: works against the hash set via setup", async () => {
  const auth = createDashboardAuth({ persistHash: async () => {} });
  await auth.setup(fakeReq({ body: { password: "my-real-password" } }), fakeRes());

  const bad = fakeRes();
  auth.login(fakeReq({ body: { password: "nope" } }), bad);
  assert.equal(bad.statusCode, 401);

  const ok = fakeRes();
  auth.login(fakeReq({ body: { password: "my-real-password" } }), ok);
  assert.equal(ok.body.success, true);
  const token = cookieFromSetHeader(ok);
  const guarded = fakeRes();
  let passed = false;
  auth.requireAuth(fakeReq({ cookie: cookieHeader(token) }), guarded, () => { passed = true; });
  assert.equal(passed, true);
});

// ── login against an env password ──────────────────────────────────────

test("env password: setup is skipped and login uses the env value", () => {
  const auth = createDashboardAuth({ envPassword: "from-the-environment" });
  assert.equal(auth.needsSetup(), false);

  const state = fakeRes();
  auth.authState(fakeReq(), state);
  assert.deepEqual(state.body, { mode: "login" });

  const ok = fakeRes();
  auth.login(fakeReq({ body: { password: "from-the-environment" } }), ok);
  assert.equal(ok.body.success, true);
});

test("env password: per-IP lockout still applies", () => {
  const auth = createDashboardAuth({ envPassword: "pw-value" });
  for (let i = 0; i < 5; i++) {
    auth.login(fakeReq({ body: { password: "wrong" }, ip: "9.9.9.9" }), fakeRes());
  }
  const res = fakeRes();
  auth.login(fakeReq({ body: { password: "pw-value" }, ip: "9.9.9.9" }), res);
  assert.equal(res.statusCode, 429);
});

// ── change password ────────────────────────────────────────────────────

test("changePassword: requires the correct current password, then rotates", async () => {
  let persisted = null;
  const auth = createDashboardAuth({ persistHash: async (h) => { persisted = h; } });
  await auth.setup(fakeReq({ body: { password: "original-pass" } }), fakeRes());

  const wrong = fakeRes();
  await auth.changePassword(fakeReq({ body: { currentPassword: "bad", newPassword: "new-pass-1" } }), wrong);
  assert.equal(wrong.statusCode, 401);

  const ok = fakeRes();
  await auth.changePassword(fakeReq({ body: { currentPassword: "original-pass", newPassword: "brand-new-pass" } }), ok);
  assert.equal(ok.body.success, true);
  assert.equal(verifyPassword("brand-new-pass", persisted), true);

  // old password no longer logs in, new one does
  const oldTry = fakeRes();
  auth.login(fakeReq({ body: { password: "original-pass" } }), oldTry);
  assert.equal(oldTry.statusCode, 401);
  const newTry = fakeRes();
  auth.login(fakeReq({ body: { password: "brand-new-pass" } }), newTry);
  assert.equal(newTry.body.success, true);
});

test("changePassword: refused when an env password is in force", async () => {
  const auth = createDashboardAuth({ envPassword: "env-pw" });
  const res = fakeRes();
  await auth.changePassword(fakeReq({ body: { currentPassword: "env-pw", newPassword: "something-new" } }), res);
  assert.equal(res.statusCode, 400);
});

// ── session handling ───────────────────────────────────────────────────

test("requireAuth: rejects no cookie / forged cookie / after logout", async () => {
  const auth = createDashboardAuth({ persistHash: async () => {} });
  await auth.setup(fakeReq({ body: { password: "session-test-pw" } }), fakeRes());
  const loginRes = fakeRes();
  auth.login(fakeReq({ body: { password: "session-test-pw" } }), loginRes);
  const token = cookieFromSetHeader(loginRes);

  const noCookie = fakeRes();
  let n1 = false;
  auth.requireAuth(fakeReq(), noCookie, () => { n1 = true; });
  assert.equal(n1, false);
  assert.equal(noCookie.statusCode, 401);

  const forged = fakeRes();
  let n2 = false;
  auth.requireAuth(fakeReq({ cookie: "hooper_session=forged" }), forged, () => { n2 = true; });
  assert.equal(n2, false);

  auth.logout(fakeReq({ cookie: cookieHeader(token) }), fakeRes());
  const afterLogout = fakeRes();
  let n3 = false;
  auth.requireAuth(fakeReq({ cookie: cookieHeader(token) }), afterLogout, () => { n3 = true; });
  assert.equal(n3, false);
});

test("setStoredHash: a hash loaded after construction lifts setup mode", () => {
  const auth = createDashboardAuth({});
  assert.equal(auth.needsSetup(), true);
  auth.setStoredHash(hashPassword("loaded-from-db"));
  assert.equal(auth.needsSetup(), false);
  const ok = fakeRes();
  auth.login(fakeReq({ body: { password: "loaded-from-db" } }), ok);
  assert.equal(ok.body.success, true);
});
