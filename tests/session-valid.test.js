import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import MongoAuth from "../System/MongoAuth/MongoAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_BASE = path.join(__dirname, "..", "System", "session");

async function withSession(id, credsContent, fn) {
  const dir = path.join(SESSION_BASE, id);
  await fs.mkdir(dir, { recursive: true });
  try {
    if (credsContent !== undefined) {
      await fs.writeFile(path.join(dir, "creds.json"), credsContent);
    }
    await fn(new MongoAuth(id));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("_localSessionValid: true for a registered session", () =>
  withSession("__test_valid_registered__", JSON.stringify({ registered: true }), async (auth) => {
    assert.equal(await auth._localSessionValid(), true);
  }));

test("_localSessionValid: true when me.id is present", () =>
  withSession("__test_valid_me__", JSON.stringify({ me: { id: "12345@s.whatsapp.net" } }), async (auth) => {
    assert.equal(await auth._localSessionValid(), true);
  }));

test("_localSessionValid: false for a fresh unregistered creds.json", () =>
  withSession("__test_unregistered__", JSON.stringify({ registered: false, noiseKey: {} }), async (auth) => {
    assert.equal(await auth._localSessionValid(), false);
  }));

test("_localSessionValid: false for corrupt JSON", () =>
  withSession("__test_corrupt__", "{ not valid json", async (auth) => {
    assert.equal(await auth._localSessionValid(), false);
  }));

test("_localSessionValid: false when creds.json is missing entirely", () =>
  withSession("__test_missing__", undefined, async (auth) => {
    assert.equal(await auth._localSessionValid(), false);
  }));
