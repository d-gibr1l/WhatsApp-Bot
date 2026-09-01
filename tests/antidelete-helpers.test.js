import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveUser,
  resolveParties,
  pickMedia,
  sanitizeMentions,
} from "../src/antidelete-helpers.js";

// ── resolveUser ──────────────────────────────────────────────────────────

test("resolveUser: passes through a normal user JID", () => {
  assert.equal(resolveUser("15551234567@s.whatsapp.net"), "15551234567@s.whatsapp.net");
});

test("resolveUser: rejects a group JID (the bug behind 'from one group')", () => {
  assert.equal(resolveUser("120363012345678901@g.us"), "");
});

test("resolveUser: rejects status@broadcast", () => {
  assert.equal(resolveUser("status@broadcast"), "");
});

test("resolveUser: maps a known @lid to its phone JID", () => {
  const lidMap = new Map([["999@lid", "15551234567@s.whatsapp.net"]]);
  assert.equal(resolveUser("999@lid", lidMap), "15551234567@s.whatsapp.net");
});

test("resolveUser: drops an unmapped @lid instead of mentioning the raw lid", () => {
  assert.equal(resolveUser("999@lid", new Map()), "");
  assert.equal(resolveUser("999@lid", undefined), "");
});

test("resolveUser: strips device suffixes", () => {
  assert.equal(resolveUser("15551234567:12@s.whatsapp.net"), "15551234567@s.whatsapp.net");
});

test("resolveUser: empty input", () => {
  assert.equal(resolveUser(""), "");
  assert.equal(resolveUser(null), "");
});

// ── resolveParties ───────────────────────────────────────────────────────

test("resolveParties: group message uses key.participant as the author", () => {
  const { actualSender, deleter } = resolveParties({
    cachedKey: { remoteJid: "120363012345678901@g.us", participant: "15551234567@s.whatsapp.net", fromMe: false },
    chatId: "120363012345678901@g.us",
    updateParticipant: "15551234567@s.whatsapp.net",
  });
  assert.equal(actualSender, "15551234567@s.whatsapp.net");
  assert.equal(deleter, "15551234567@s.whatsapp.net");
});

test("resolveParties: group message with NO participant never falls back to the group JID", () => {
  // This is the exact scenario that used to mention the group instead of the sender.
  const { actualSender, deleter } = resolveParties({
    cachedKey: { remoteJid: "120363012345678901@g.us", fromMe: false }, // participant missing
    chatId: "120363012345678901@g.us",
    updateParticipant: "",
  });
  assert.equal(actualSender, "");
  assert.equal(deleter, "");
});

test("resolveParties: 1:1 chat falls back to remoteJid (that IS the user)", () => {
  const { actualSender, deleter } = resolveParties({
    cachedKey: { remoteJid: "15551234567@s.whatsapp.net", fromMe: false }, // no participant in a PM
    chatId: "15551234567@s.whatsapp.net",
    updateParticipant: "",
  });
  assert.equal(actualSender, "15551234567@s.whatsapp.net");
  assert.equal(deleter, "15551234567@s.whatsapp.net");
});

test("resolveParties: admin revoke (stub 132) uses update.participant as the deleter, not the author", () => {
  const { actualSender, deleter } = resolveParties({
    cachedKey: { remoteJid: "120363012345678901@g.us", participant: "15551111111@s.whatsapp.net", fromMe: false },
    chatId: "120363012345678901@g.us",
    updateParticipant: "15552222222@s.whatsapp.net", // the admin who deleted it
  });
  assert.equal(actualSender, "15551111111@s.whatsapp.net");
  assert.equal(deleter, "15552222222@s.whatsapp.net");
});

test("resolveParties: resolves a group author's @lid via the map", () => {
  const lidMap = new Map([["777@lid", "15559999999@s.whatsapp.net"]]);
  const { actualSender } = resolveParties({
    cachedKey: { remoteJid: "120363012345678901@g.us", participant: "777@lid", fromMe: false },
    chatId: "120363012345678901@g.us",
    lidMap,
  });
  assert.equal(actualSender, "15559999999@s.whatsapp.net");
});

test("resolveParties: fromMe uses the bot's own id", () => {
  const { actualSender } = resolveParties({
    cachedKey: { remoteJid: "120363012345678901@g.us", fromMe: true },
    chatId: "120363012345678901@g.us",
    botUserId: "15550000000:5@s.whatsapp.net",
  });
  assert.equal(actualSender, "15550000000@s.whatsapp.net");
});

// ── pickMedia ────────────────────────────────────────────────────────────

test("pickMedia: known media types map to a valid downloadContentFromMessage type", () => {
  assert.deepEqual(pickMedia("imageMessage"), { mediaLabel: "picture", mediaType: "image" });
  assert.deepEqual(pickMedia("videoMessage"), { mediaLabel: "video", mediaType: "video" });
  assert.deepEqual(pickMedia("ptvMessage"), { mediaLabel: "video note", mediaType: "ptv" });
  assert.deepEqual(pickMedia("audioMessage"), { mediaLabel: "audio", mediaType: "audio" });
  assert.deepEqual(pickMedia("stickerMessage"), { mediaLabel: "sticker", mediaType: "sticker" });
  assert.deepEqual(pickMedia("documentMessage"), { mediaLabel: "document", mediaType: "document" });
  assert.deepEqual(pickMedia("documentWithCaptionMessage"), { mediaLabel: "document", mediaType: "document" });
});

test("pickMedia: text types get no media type", () => {
  assert.deepEqual(pickMedia("conversation"), { mediaLabel: "message", mediaType: null });
  assert.deepEqual(pickMedia("extendedTextMessage"), { mediaLabel: "message", mediaType: null });
});

test("pickMedia: unknown/undownloadable content types never yield an invalid download type", () => {
  // This used to fall through to mediaType "message", an invalid arg to
  // downloadContentFromMessage — now it's null and callers must branch on that.
  for (const type of ["pollCreationMessage", "locationMessage", "contactMessage", undefined, ""]) {
    assert.equal(pickMedia(type).mediaType, null);
  }
});

// ── sanitizeMentions ─────────────────────────────────────────────────────

test("sanitizeMentions: keeps real user JIDs", () => {
  assert.deepEqual(
    sanitizeMentions(["15551234567@s.whatsapp.net", "15557654321@s.whatsapp.net"]),
    ["15551234567@s.whatsapp.net", "15557654321@s.whatsapp.net"],
  );
});

test("sanitizeMentions: strips group/broadcast/empty/falsy entries", () => {
  assert.deepEqual(
    sanitizeMentions(["120363012345678901@g.us", "status@broadcast", "", null, undefined, "15551234567@s.whatsapp.net"]),
    ["15551234567@s.whatsapp.net"],
  );
});

test("sanitizeMentions: handles an empty/missing list", () => {
  assert.deepEqual(sanitizeMentions([]), []);
  assert.deepEqual(sanitizeMentions(undefined), []);
});

test("sanitizeMentions: dedupes (admin revoking their own message mentions them once, not twice)", () => {
  assert.deepEqual(
    sanitizeMentions(["15551234567@s.whatsapp.net", "15551234567@s.whatsapp.net"]),
    ["15551234567@s.whatsapp.net"],
  );
});
