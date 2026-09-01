import test from "node:test";
import assert from "node:assert/strict";
import { coerceBool } from "../src/settings-util.js";

test("coerceBool: real booleans pass through", () => {
  assert.equal(coerceBool(true), true);
  assert.equal(coerceBool(false), false);
});

test('coerceBool: the string "false" is false, not truthy', () => {
  // This is the actual bug: Setting.value is a String in Mongo, so a stored
  // `false` reads back as "false" and `if (v)` was always taken.
  assert.equal(coerceBool("false"), false);
});

test('coerceBool: "true" / "1" / 1 are true', () => {
  assert.equal(coerceBool("true"), true);
  assert.equal(coerceBool("1"), true);
  assert.equal(coerceBool(1), true);
});

test("coerceBool: unset / junk values are false", () => {
  assert.equal(coerceBool(undefined), false);
  assert.equal(coerceBool(null), false);
  assert.equal(coerceBool(""), false);
  assert.equal(coerceBool("0"), false);
  assert.equal(coerceBool("nope"), false);
});
