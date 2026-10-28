import test from "node:test";
import assert from "node:assert/strict";

// Validation rules mirrored from dashboard endpoints
const ALLOWED_CONFIG_KEYS = new Set([
  "HOOPER_PREFIX",
  "HOOPER_MODS",
  "HOOPER_PACKNAME",
  "HOOPER_AUTHOR",
  "HOOPER_GEMINI_API",
  "HOOPER_OPENAI_API",
  "HOOPER_CLAUDE_API",
  "HOOPER_TENOR_API",
  "HOOPER_TMDB_API",
  "HOOPER_GC_INTERVAL",
  "yt_cookies",
  "rapidapi_key",
  "HOOPER_VIEWONCE_EMOJIS",
]);

const ALLOWED_GROUP_FEATURES = new Set([
  "antilink",
  "antidelete",
  "chatBot",
  "switchWelcome",
  "nsfw",
  "botSwitch",
  "bangroup",
  "allowed",
]);

function validatePairPhone(phone) {
  if (!phone || typeof phone !== "string") return false;
  const cleaned = phone.replace(/[^0-9]/g, "");
  return cleaned.length >= 7 && cleaned.length <= 15;
}

function validateGroupToggle(groupId, feature) {
  if (!groupId || typeof groupId !== "string" || !groupId.endsWith("@g.us")) return false;
  return ALLOWED_GROUP_FEATURES.has(feature);
}

function validateBanInput(id, type) {
  if (!id || typeof id !== "string" || !id.trim()) return false;
  return type === "user" || type === "group";
}

test("Dashboard API: ALLOWED_CONFIG_KEYS permits valid settings and blocks dangerous/internal keys", () => {
  assert.equal(ALLOWED_CONFIG_KEYS.has("HOOPER_PREFIX"), true);
  assert.equal(ALLOWED_CONFIG_KEYS.has("yt_cookies"), true);
  assert.equal(ALLOWED_CONFIG_KEYS.has("rapidapi_key"), true);
  assert.equal(ALLOWED_CONFIG_KEYS.has("HOOPER_GC_INTERVAL"), true);

  // Must not allow internal credentials or arbitrary keys
  assert.equal(ALLOWED_CONFIG_KEYS.has("HOOPER_SESSION_ID"), false);
  assert.equal(ALLOWED_CONFIG_KEYS.has("MONGODB"), false);
  assert.equal(ALLOWED_CONFIG_KEYS.has("__proto__"), false);
  assert.equal(ALLOWED_CONFIG_KEYS.has("unknownKey"), false);
});

test("Dashboard API: pair endpoint phone number validation", () => {
  assert.equal(validatePairPhone("1234567890"), true);
  assert.equal(validatePairPhone("+1 (234) 567-8901"), true);
  assert.equal(validatePairPhone(""), false);
  assert.equal(validatePairPhone(null), false);
  assert.equal(validatePairPhone(1234567890), false); // must be string
  assert.equal(validatePairPhone("12345"), false); // too short
  assert.equal(validatePairPhone("123456789012345678"), false); // too long
  assert.equal(validatePairPhone("invalid-phone"), false);
});

test("Dashboard API: group feature toggle validation", () => {
  assert.equal(validateGroupToggle("123456789@g.us", "antilink"), true);
  assert.equal(validateGroupToggle("123456789@g.us", "nsfw"), true);
  assert.equal(validateGroupToggle("123456789@g.us", "allowed"), true);

  // Rejects invalid feature
  assert.equal(validateGroupToggle("123456789@g.us", "malicious_cmd"), false);
  // Rejects non-group JIDs
  assert.equal(validateGroupToggle("123456789@s.whatsapp.net", "antilink"), false);
  assert.equal(validateGroupToggle("", "antilink"), false);
  assert.equal(validateGroupToggle(null, "antilink"), false);
});

test("Dashboard API: ban and unban entity input validation", () => {
  assert.equal(validateBanInput("123456789@s.whatsapp.net", "user"), true);
  assert.equal(validateBanInput("987654321@g.us", "group"), true);

  // Rejects invalid type
  assert.equal(validateBanInput("12345", "admin"), false);
  assert.equal(validateBanInput("12345", ""), false);
  assert.equal(validateBanInput("12345", null), false);

  // Rejects empty/invalid id
  assert.equal(validateBanInput("", "user"), false);
  assert.equal(validateBanInput("   ", "user"), false);
  assert.equal(validateBanInput(null, "user"), false);
});
