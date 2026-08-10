import assert from 'assert';

// ─── Replicating logic under test from src/auth/redisSession.js ───────────────

const escapeGlob = (s) => s.replace(/[*?[\]\\]/g, '\\$&');

const bufferReviver = (keyName, value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const arr = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        arr[i] = value[i];
      }
      return Buffer.from(arr);
    }
  }
  return value;
};

const serialize = (value) =>
  JSON.stringify(value, (key, val) => {
    if (val instanceof Uint8Array && !Buffer.isBuffer(val)) {
      return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
    }
    return val;
  });

const deserialize = (raw) => {
  if (!raw) return null;
  return JSON.parse(raw, bufferReviver);
};

function getPurgePatternsForJid(jid, sessionId = 'unknown') {
  const isGroup = jid.endsWith('@g.us');
  // Current implementation in redisSession.js line 456:
  const base = escapeGlob(isGroup ? jid : jid.split(':')[0].split('.')[0]);

  const patterns = isGroup
    ? [
        `${sessionId}:sender-key-${base}::*`,
        `${sessionId}:sender-key-memory-${base}`,
      ]
    : [
        `${sessionId}:session-${base}.*`,
        `${sessionId}:sender-key-*::${base}::*`,
      ];
  return { isGroup, base, patterns };
}

// Fixed version of base extraction for comparison:
function getPurgePatternsForJidFixed(jid, sessionId = 'unknown') {
  const isGroup = jid.endsWith('@g.us');
  const base = escapeGlob(isGroup ? jid : jid.split('@')[0].split(':')[0].split('.')[0]);

  const patterns = isGroup
    ? [
        `${sessionId}:sender-key-${base}::*`,
        `${sessionId}:sender-key-memory-${base}`,
      ]
    : [
        `${sessionId}:session-${base}.*`,
        `${sessionId}:sender-key-*::${base}::*`,
      ];
  return { isGroup, base, patterns };
}

// ─── Replicating logic under test from src/auth/badMacInterceptor.js ─────────

const SIGNAL_ADDRESS_RE = /^[\w-]+\.\d+$/;

function extractKeyId(errOrObj) {
  if (!errOrObj) return null;

  let stackParts = [];

  if (typeof errOrObj === 'string') {
    stackParts.push(errOrObj);
  } else if (typeof errOrObj === 'object') {
    if (errOrObj.stack) stackParts.push(String(errOrObj.stack));
    if (errOrObj.message) stackParts.push(String(errOrObj.message));
    if (errOrObj.jid) stackParts.push(String(errOrObj.jid));
    if (errOrObj.chatId) stackParts.push(String(errOrObj.chatId));
    if (errOrObj.sender) stackParts.push(String(errOrObj.sender));
    if (errOrObj.remoteJid) stackParts.push(String(errOrObj.remoteJid));
    if (errOrObj.id) stackParts.push(String(errOrObj.id));
    if (errOrObj.err) {
      if (errOrObj.err.stack) stackParts.push(String(errOrObj.err.stack));
      if (errOrObj.err.message) stackParts.push(String(errOrObj.err.message));
    }
    if (errOrObj.cause) {
      if (errOrObj.cause.stack) stackParts.push(String(errOrObj.cause.stack));
      if (errOrObj.cause.message) stackParts.push(String(errOrObj.cause.message));
    }
  }

  const stack = stackParts.join('\n');
  if (!stack) return null;

  const queueMatch = stack.match(/at async ([\w.@:+-]+)\s+\[as awaitable\]/);
  if (queueMatch && SIGNAL_ADDRESS_RE.test(queueMatch[1])) {
    return { type: 'session', id: queueMatch[1], exact: true };
  }

  const addrMatch = stack.match(/address:\s*([\w.@:+-]+)/);
  if (addrMatch && SIGNAL_ADDRESS_RE.test(addrMatch[1])) {
    return { type: 'session', id: addrMatch[1], exact: true };
  }

  const userJid = stack.match(/(\d+)(?::(\d+))?@(?:s\.whatsapp\.net|lid)(?:\.(\d+))?/);
  if (userJid) {
    const device = userJid[2] ?? userJid[3] ?? '0';
    return { type: 'session', id: `${userJid[1]}.${device}`, exact: true };
  }

  const groupMatch = stack.match(/(\d+@g\.us)/);
  if (groupMatch) return { type: 'sender-key', id: groupMatch[1], exact: false };

  return null;
}

function getBaseJid(id) {
  if (!id) return '';
  if (id.endsWith('@g.us')) return id;
  return id.split('@')[0].split(':')[0].split('.')[0];
}

// Mocking Circuit Breaker Logic
class CircuitBreakerHarness {
  constructor(purgeAllForJidMock, purgeCorruptKeyMock) {
    this.badMacCounts = new Map();
    this._recentlyPurged = new Map();
    this._wipesInFlight = new Map();
    this.purgeAllForJid = purgeAllForJidMock;
    this.purgeCorruptKey = purgeCorruptKeyMock;
    this.PURGE_DEDUP_MS = 2000;
  }

  async purgeForBadMac(keyInfo) {
    const now = Date.now();
    const baseJid = getBaseJid(keyInfo.id);

    const inFlight = this._wipesInFlight.get(baseJid);
    if (inFlight) return inFlight;

    let stats = this.badMacCounts.get(baseJid) || { count: 0, windowStart: now };
    if (now - stats.windowStart > 60_000) {
      stats = { count: 0, windowStart: now };
    }
    stats.count++;
    this.badMacCounts.set(baseJid, stats);

    if (this.purgeAllForJid && stats.count >= 3) {
      this.badMacCounts.delete(baseJid);
      this._recentlyPurged.delete(baseJid);

      const wipe = Promise.resolve(this.purgeAllForJid(baseJid))
        .finally(() => this._wipesInFlight.delete(baseJid));
      this._wipesInFlight.set(baseJid, wipe);
      return wipe;
    }

    if (!keyInfo.exact) return;

    const last = this._recentlyPurged.get(keyInfo.id) ?? 0;
    if (now - last < this.PURGE_DEDUP_MS) return;
    this._recentlyPurged.set(keyInfo.id, now);

    await this.purgeCorruptKey(keyInfo.type, keyInfo.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== STARTING EXTENDED EMPIRICAL TEST SUITE ===\n');

const results = [];

function recordTest(category, name, passed, details) {
  results.push({ category, name, passed, details });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${category} :: ${name}`);
  if (details) console.log(`       Details: ${details}`);
}

// ── CATEGORY 1: JID CLASSIFICATION ──
console.log('--- Category 1: JID Classification Logic ---');

// 1.1 Standard User JID '12345@s.whatsapp.net'
{
  const cur = getPurgePatternsForJid('12345@s.whatsapp.net');
  const fix = getPurgePatternsForJidFixed('12345@s.whatsapp.net');
  const redisKey = 'unknown:session-12345.0';

  const curMatch = new RegExp('^' + cur.patterns[0].replace('*', '.*') + '$').test(redisKey);
  const fixMatch = new RegExp('^' + fix.patterns[0].replace('*', '.*') + '$').test(redisKey);

  recordTest(
    'JID Classification',
    "User JID '12345@s.whatsapp.net' (Current vs Fixed)",
    curMatch === true,
    `Current base='${cur.base}', pattern='${cur.patterns[0]}', matches Redis key '${redisKey}'? ${curMatch}. ` +
    `Fixed base='${fix.base}', pattern='${fix.patterns[0]}', matches Redis key '${redisKey}'? ${fixMatch}.`
  );
}

// 1.2 Group JID '123456789@g.us'
{
  const cur = getPurgePatternsForJid('123456789@g.us');
  recordTest(
    'JID Classification',
    "Group JID '123456789@g.us'",
    cur.isGroup === true && cur.base === '123456789@g.us',
    `base='${cur.base}', patterns=[${cur.patterns.join(', ')}]`
  );
}

// ── CATEGORY 2: BUFFER & UINT8ARRAY ROUNDTRIPS ──
console.log('\n--- Category 2: Buffer / Uint8Array Serialization & Reviver ---');

// 2.1 Standard Buffer
{
  const buf = Buffer.from([1, 2, 3, 4, 5]);
  const revived = deserialize(serialize(buf));
  const pass = Buffer.isBuffer(revived) && revived.equals(buf);
  recordTest('Buffer & Uint8Array', 'Standard Buffer', pass, `Equals original? ${pass}`);
}

// 2.2 Standard Uint8Array
{
  const u8 = new Uint8Array([1, 2, 3, 4, 5]);
  const revived = deserialize(serialize(u8));
  const pass = Buffer.isBuffer(revived) && revived.length === 5 && revived[0] === 1;
  recordTest('Buffer & Uint8Array', 'Standard Uint8Array', pass, `Length: ${revived?.length}`);
}

// 2.3 Object with numeric dictionary keys { "0": "foo", "1": "bar" }
{
  const obj = { "0": "foo", "1": "bar" };
  const revived = deserialize(serialize(obj));
  const pass = typeof revived === 'object' && !Buffer.isBuffer(revived) && revived["0"] === "foo";
  recordTest(
    'Buffer & Uint8Array',
    'Plain object { "0": "foo", "1": "bar" }',
    pass,
    `Revived type: ${typeof revived}, isBuffer: ${Buffer.isBuffer(revived)}, Content: ${JSON.stringify(revived)}`
  );
}

// 2.4 Object with non-contiguous numeric keys { "10": "val" }
{
  const obj = { "10": "val" };
  const revived = deserialize(serialize(obj));
  const pass = typeof revived === 'object' && !Buffer.isBuffer(revived) && revived["10"] === "val";
  recordTest(
    'Buffer & Uint8Array',
    'Plain object { "10": "val" }',
    pass,
    `Revived type: ${typeof revived}, isBuffer: ${Buffer.isBuffer(revived)}, Content: ${JSON.stringify(revived)}`
  );
}

// ── CATEGORY 3: KEY EXTRACTION & INTERCEPTOR ──
console.log('\n--- Category 3: Key Extraction & Interceptor Harness ---');

// 3.1 Extract key from nested cause error stack
{
  const err = {
    cause: {
      stack: 'Error: Bad MAC\n at async 445566.0 [as awaitable]'
    }
  };
  const key = extractKeyId(err);
  const pass = key !== null && key.id === '445566.0';
  recordTest('Key Extraction', 'Nested cause stack extraction', pass, JSON.stringify(key));
}

// 3.2 Circuit Breaker Triggering
{
  let wipedJid = null;
  let singlePurgeKey = null;

  const harness = new CircuitBreakerHarness(
    async (jid) => { wipedJid = jid; },
    async (type, id) => { singlePurgeKey = id; }
  );

  const key1 = { type: 'session', id: '9999.0', exact: true };

  // Call 1: Single key purge
  await harness.purgeForBadMac(key1);
  const c1Pass = singlePurgeKey === '9999.0' && wipedJid === null;

  // Call 2: Duplicate within dedup window (should be ignored)
  singlePurgeKey = null;
  await harness.purgeForBadMac(key1);
  const c2Pass = singlePurgeKey === null && wipedJid === null;

  // Call 3: 3rd Bad MAC for same JID -> should trigger Circuit Breaker
  await harness.purgeForBadMac(key1);
  const c3Pass = wipedJid === '9999';

  const pass = c1Pass && c2Pass && c3Pass;
  recordTest(
    'Interceptor Harness',
    'Circuit breaker after 3 Bad MACs',
    pass,
    `Call 1 single purge ok? ${c1Pass}, Call 2 dedup ok? ${c2Pass}, Call 3 wipe triggered for JID '${wipedJid}'? ${c3Pass}`
  );
}

console.log('\n=== SUMMARY OF ALL TESTS ===');
const failed = results.filter(r => !r.passed);
console.log(`Total tests: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
