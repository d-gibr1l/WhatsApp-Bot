import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import sessionSchema from "../System/MongoAuth/Schema/SessionSchema.js";

// MongoAuth reads session docs with `.findOne()` (not `.lean()`), so it gets a
// hydrated Mongoose document. `.hydrate()` builds one from a raw object exactly
// the way a query result does — so these tests exercise the real read path.

test("legacy single-blob doc: `session` field is accessible after hydration", () => {
  const raw = {
    _id: new mongoose.Types.ObjectId(),
    sessionId: "LEGACY-1",
    session: JSON.stringify({ creds: {}, keys: {} }),
    // no `files` key at all — this is the shape that used to be invisible
  };
  const doc = sessionSchema.hydrate(raw);
  assert.equal(typeof doc.session, "string");
  assert.ok(doc.session.length > 0);
});

test("legacy doc: `files` still defaults to {} so a content check is needed, not truthiness", () => {
  const doc = sessionSchema.hydrate({
    _id: new mongoose.Types.ObjectId(),
    sessionId: "LEGACY-2",
    session: "blob",
  });
  assert.deepEqual(doc.files, {});
  const hasFiles = doc.files && Object.keys(doc.files).length > 0;
  assert.equal(hasFiles, false); // -> _downloadToLocal takes the migration branch
});

test("modern file-based doc: no session blob, files present", () => {
  const doc = sessionSchema.hydrate({
    _id: new mongoose.Types.ObjectId(),
    sessionId: "MODERN-1",
    files: { "creds.json": "eyJ4IjoxfQ==" },
  });
  assert.equal(doc.session, null);
  const hasFiles = doc.files && Object.keys(doc.files).length > 0;
  assert.equal(hasFiles, true);
});

test("empty doc: neither a session blob nor files -> treated as no backup", () => {
  const doc = sessionSchema.hydrate({
    _id: new mongoose.Types.ObjectId(),
    sessionId: "EMPTY-1",
  });
  const hasFiles = doc.files && Object.keys(doc.files).length > 0;
  assert.equal(hasFiles, false);
  assert.equal(doc.session, null);
});
