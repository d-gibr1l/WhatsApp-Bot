import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSessionId } from "../System/MongoAuth/MongoAuth.js";

test("sanitizeSessionId: passes through a normal generated id", () => {
  assert.equal(sanitizeSessionId("HOOPER-MD-AB12CD34"), "HOOPER-MD-AB12CD34");
});

test("sanitizeSessionId: allows dots, underscores, hyphens", () => {
  assert.equal(sanitizeSessionId("my_session.v2-final"), "my_session.v2-final");
});

test("sanitizeSessionId: strips slashes and other separators", () => {
  assert.equal(sanitizeSessionId("foo/bar\\baz"), "foobarbaz");
  assert.equal(sanitizeSessionId("a b:c;d"), "abcd");
});

test("sanitizeSessionId: rejects a pure traversal segment", () => {
  assert.throws(() => sanitizeSessionId(".."), /path traversal/);
});

test("sanitizeSessionId: a traversal payload with separators collapses to a harmless name", () => {
  // slashes are stripped first, so "../../etc" -> "....etc" (a literal dir name)
  assert.equal(sanitizeSessionId("../../etc"), "....etc");
});

test("sanitizeSessionId: rejects empty / whitespace / null", () => {
  assert.throws(() => sanitizeSessionId(""), /empty after sanitizing/);
  assert.throws(() => sanitizeSessionId("   "), /empty after sanitizing/);
  assert.throws(() => sanitizeSessionId(null), /empty after sanitizing/);
  assert.throws(() => sanitizeSessionId(undefined), /empty after sanitizing/);
});

test("sanitizeSessionId: rejects a value that is only stripped characters", () => {
  assert.throws(() => sanitizeSessionId("/////"), /empty after sanitizing/);
});
