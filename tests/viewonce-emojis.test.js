import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VIEWONCE_EMOJIS,
  MAX_VIEWONCE_EMOJIS,
  parseEmojiList,
  emojisFromSetting,
  emojisToSetting,
  isViewOnceTrigger,
} from "../src/viewonce-emojis.js";

test("parseEmojiList: splits comma/space separated emojis and drops non-emoji text", () => {
  assert.deepEqual(parseEmojiList("👀,🔥 abc 😂"), ["👀", "🔥", "😂"]);
  assert.deepEqual(parseEmojiList("hello, 123"), []);
});

test("parseEmojiList: keeps ZWJ sequences and flags as single entries", () => {
  assert.deepEqual(parseEmojiList("👨‍👩‍👧,🇳🇬"), ["👨‍👩‍👧", "🇳🇬"]);
});

test("parseEmojiList: de-dupes across variation selectors and caps the length", () => {
  assert.deepEqual(parseEmojiList(["❤", "❤️", "👀"]), ["❤", "👀"]);
  const many = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x1f600 + i)).join(",");
  assert.equal(parseEmojiList(many).length, MAX_VIEWONCE_EMOJIS);
});

test("parseEmojiList: tolerates null/undefined/non-strings", () => {
  assert.deepEqual(parseEmojiList(null), []);
  assert.deepEqual(parseEmojiList(undefined), []);
});

test("emojisFromSetting: unset uses the default, explicit empty disables", () => {
  assert.deepEqual(emojisFromSetting(null), DEFAULT_VIEWONCE_EMOJIS);
  assert.deepEqual(emojisFromSetting(undefined), DEFAULT_VIEWONCE_EMOJIS);
  assert.deepEqual(emojisFromSetting(""), []);
  assert.deepEqual(emojisFromSetting("🔥,👀"), ["🔥", "👀"]);
});

test("emojisToSetting: round-trips through emojisFromSetting", () => {
  const list = ["👀", "🔥"];
  assert.deepEqual(emojisFromSetting(emojisToSetting(list)), list);
});

test("isViewOnceTrigger: matches only a message that is exactly a configured emoji", () => {
  const list = ["👀", "❤️"];
  assert.equal(isViewOnceTrigger("👀", list), true);
  assert.equal(isViewOnceTrigger(" 👀 ", list), true);
  assert.equal(isViewOnceTrigger("❤", list), true); // with/without variation selector
  assert.equal(isViewOnceTrigger("👀👀", list), false);
  assert.equal(isViewOnceTrigger("nice 👀", list), false);
  assert.equal(isViewOnceTrigger("🔥", list), false);
  assert.equal(isViewOnceTrigger("", list), false);
  assert.equal(isViewOnceTrigger("👀", []), false);
  assert.equal(isViewOnceTrigger("👀", undefined), false);
});
