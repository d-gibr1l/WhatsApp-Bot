import test from "node:test";
import assert from "node:assert/strict";
import { resolveDashboardPassword, createDashboardAuth } from "../src/dashboard-auth.js";

// ── resolveDashboardPassword ────────────────────────────────────────────

test("resolveDashboardPassword: uses DASHBOARD_PASSWORD when set", () => {
  const { password, generated } = resolveDashboardPassword({ DASHBOARD_PASSWORD: "hunter2" });
  assert.equal(password, "hunter2");
  assert.equal(generated, false);
});

test("resolveDashboardPassword: generates a random one when unset", () => {
  const a = resolveDashboardPassword({});
  const b = resolveDashboardPassword({});
  assert.equal(a.generated, true);
  assert.ok(a.password.length >= 16);
  assert.notEqual(a.password, b.password); // not hardcoded/deterministic
});

test("resolveDashboardPassword: blank env value is treated as unset", () => {
  const { generated } = resolveDashboardPassword({ DASHBOARD_PASSWORD: "   " });
  assert.equal(generated, true);
});

// ── createDashboardAuth: helpers to fake express req/res ────────────────

function fakeReq({ body = {}, cookie = null, ip = "1.2.3.4" } = {}) {
  return { body, headers: cookie ? { cookie } : {}, ip, secure: false };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
  return res;
}

function cookieFromSetHeader(res) {
  const raw = res.headers["Set-Cookie"];
  if (!raw) return null;
  const match = raw.match(/^hooper_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// ── login ────────────────────────────────────────────────────────────────

test("login: correct password sets a session cookie", () => {
  const auth = createDashboardAuth({ password: "correct-horse" });
  const req = fakeReq({ body: { password: "correct-horse" } });
  const res = fakeRes();
  auth.login(req, res);
  assert.equal(res.body.success, true);
  assert.ok(cookieFromSetHeader(res));
});

test("login: wrong password is rejected with no cookie", () => {
  const auth = createDashboardAuth({ password: "correct-horse" });
  const req = fakeReq({ body: { password: "wrong" } });
  const res = fakeRes();
  auth.login(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(cookieFromSetHeader(res), null);
});

test("login: missing password field is rejected, not thrown", () => {
  const auth = createDashboardAuth({ password: "correct-horse" });
  const req = fakeReq({ body: {} });
  const res = fakeRes();
  assert.doesNotThrow(() => auth.login(req, res));
  assert.equal(res.statusCode, 401);
});

test("login: lockout kicks in after repeated failures from the same IP", () => {
  const auth = createDashboardAuth({ password: "correct-horse" });
  const ip = "9.9.9.9";
  for (let i = 0; i < 5; i++) {
    const res = fakeRes();
    auth.login(fakeReq({ body: { password: "wrong" }, ip }), res);
    assert.equal(res.statusCode, 401);
  }
  // 6th attempt, even with the correct password, is locked out.
  const res = fakeRes();
  auth.login(fakeReq({ body: { password: "correct-horse" }, ip }), res);
  assert.equal(res.statusCode, 429);
});

test("login: lockout is per-IP, not global", () => {
  const auth = createDashboardAuth({ password: "correct-horse" });
  for (let i = 0; i < 5; i++) {
    auth.login(fakeReq({ body: { password: "wrong" }, ip: "1.1.1.1" }), fakeRes());
  }
  const res = fakeRes();
  auth.login(fakeReq({ body: { password: "correct-horse" }, ip: "2.2.2.2" }), res);
  assert.equal(res.body.success, true);
});

// ── requireAuth ──────────────────────────────────────────────────────────

test("requireAuth: rejects a request with no cookie", () => {
  const auth = createDashboardAuth({ password: "pw" });
  const req = fakeReq();
  const res = fakeRes();
  let nextCalled = false;
  auth.requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireAuth: accepts a request with a valid session cookie from login", () => {
  const auth = createDashboardAuth({ password: "pw" });
  const loginRes = fakeRes();
  auth.login(fakeReq({ body: { password: "pw" } }), loginRes);
  const token = cookieFromSetHeader(loginRes);

  const req = fakeReq({ cookie: `hooper_session=${encodeURIComponent(token)}` });
  const res = fakeRes();
  let nextCalled = false;
  auth.requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("requireAuth: rejects a garbage/forged cookie", () => {
  const auth = createDashboardAuth({ password: "pw" });
  const req = fakeReq({ cookie: "hooper_session=not-a-real-token" });
  const res = fakeRes();
  let nextCalled = false;
  auth.requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireAuth: rejects after logout", () => {
  const auth = createDashboardAuth({ password: "pw" });
  const loginRes = fakeRes();
  auth.login(fakeReq({ body: { password: "pw" } }), loginRes);
  const token = cookieFromSetHeader(loginRes);
  const cookie = `hooper_session=${encodeURIComponent(token)}`;

  auth.logout(fakeReq({ cookie }), fakeRes());

  const req = fakeReq({ cookie });
  const res = fakeRes();
  let nextCalled = false;
  auth.requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireAuth: unrelated cookies alongside the session cookie are parsed correctly", () => {
  const auth = createDashboardAuth({ password: "pw" });
  const loginRes = fakeRes();
  auth.login(fakeReq({ body: { password: "pw" } }), loginRes);
  const token = cookieFromSetHeader(loginRes);

  const req = fakeReq({ cookie: `theme=dark; hooper_session=${encodeURIComponent(token)}; other=1` });
  const res = fakeRes();
  let nextCalled = false;
  auth.requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
