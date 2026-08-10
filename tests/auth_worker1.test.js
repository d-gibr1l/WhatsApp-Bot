import assert from 'node:assert/strict';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../src/auth/badMacInterceptor.js';
import * as redisSession from '../src/auth/redisSession.js';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';

console.log('--- Starting Worker 1 Feature Verification Tests ---');

// Test 1: Fast-Path String Check & Interceptor Installation
console.log('Test 1: Bad MAC Interceptor Fast-Path & Installation');
let purgedKey = null;
let purgedJid = null;

installBadMacInterceptor(
  async (type, id) => { purgedKey = { type, id }; },
  () => 'test-session',
  async (jid) => { purgedJid = jid; }
);

const nestedError = {
  name: 'Error',
  message: 'Failed decryption',
  cause: {
    reason: {
      stack: 'Error: Bad MAC\n at async 551199999999.0 [as awaitable]'
    }
  }
};

console.error("Bad MAC error occurred:", nestedError);
await new Promise(r => setTimeout(r, 50));

assert.ok(purgedKey !== null, 'Nested error key should be extracted recursively');
assert.equal(purgedKey.id, '551199999999.0', 'Key ID should match extracted address');
console.log('✅ Test 1 Passed: Fast-Path & Recursive Error Extraction OK');

// Test 2: Circuit Breaker Preservation on Rejection (Task 8)
console.log('Test 2: Circuit Breaker Failure Counter Preservation on Rejection');

let wipeAttempts = 0;
uninstallBadMacInterceptor();
installBadMacInterceptor(
  async (type, id) => {},
  () => 'test-session',
  async (jid) => {
    wipeAttempts++;
    if (wipeAttempts === 1) {
      throw new Error('Redis network error on purgeAllKeysForJid');
    }
  }
);

const jidError = {
  stack: 'Error: Bad MAC\n at async 558888888888.0 [as awaitable]'
};

console.error(jidError);
console.error(jidError);
console.error(jidError);

await new Promise(r => setTimeout(r, 100));

console.error(jidError);
await new Promise(r => setTimeout(r, 100));

assert.ok(wipeAttempts >= 2, 'Circuit breaker should retry wipe on next failure after rejection');
console.log('✅ Test 2 Passed: Circuit Breaker Preservation OK');

uninstallBadMacInterceptor();

// Test 3: BufferJSON Serialization (Task 3)
console.log('Test 3: BufferJSON Serialization & Deserialization');
const creds = initAuthCreds();
const serialized = JSON.stringify(creds, BufferJSON.replacer);
assert.ok(!serialized.includes('"data":['), 'BufferJSON.replacer should not serialize buffers as numeric arrays');
assert.ok(serialized.includes('"type":"Buffer"'), 'BufferJSON should serialize buffers with type Buffer');

const parsed = JSON.parse(serialized, BufferJSON.reviver);
assert.ok(Buffer.isBuffer(parsed.noiseKey.private), 'BufferJSON.reviver should revive buffer objects');
console.log('✅ Test 3 Passed: BufferJSON Serialization OK');

// Test 4: Module Exports & Clear Session (Task 5)
console.log('Test 4: Clear Session and Module Exports');
assert.equal(typeof redisSession.getAuthState, 'function');
assert.equal(typeof redisSession.clearSession, 'function');
assert.equal(typeof redisSession.purgeCorruptKey, 'function');
assert.equal(typeof redisSession.purgeAllKeysForJid, 'function');
console.log('✅ Test 4 Passed: Module Exports & Functions OK');

// Test 5: Wrapped Bad MAC Error Inspection in _unhandledHandler
console.log('Test 5: Wrapped Bad MAC Error Inspection in _unhandledHandler');
uninstallBadMacInterceptor();

let purgedWrappedKey = null;
installBadMacInterceptor(
  async (type, id) => { purgedWrappedKey = { type, id }; },
  () => 'test-session',
  async (jid) => {}
);

const wrappedBadMacError = new Error('Outer error', {
  cause: new Error('Bad MAC error\n at async 559999999999.0 [as awaitable]')
});

process.emit('unhandledRejection', wrappedBadMacError);
await new Promise(r => setTimeout(r, 100));

assert.ok(purgedWrappedKey !== null, 'Wrapped Bad MAC error should be intercepted without triggering escalateRejection');
assert.equal(purgedWrappedKey.id, '559999999999.0', 'Key ID extracted from nested cause should match exact address format');
console.log('✅ Test 5 Passed: Wrapped Bad MAC Error Inspection OK');

// Test 6: Key ID Format in _recentlyPurged
console.log('Test 6: Key ID Format Matching and Deletion in _recentlyPurged');
uninstallBadMacInterceptor();

let singlePurgedKeys = [];
let circuitBreakerWipes = [];

installBadMacInterceptor(
  async (type, id) => { singlePurgedKeys.push(id); },
  () => 'test-session',
  async (jid) => { circuitBreakerWipes.push(jid); }
);

const keyErr = { stack: 'Error: Bad MAC\n at async 557777777777.0 [as awaitable]' };

// First error purges 557777777777.0 and places exact key ID in _recentlyPurged
process.emit('unhandledRejection', keyErr);
await new Promise(r => setTimeout(r, 50));
assert.equal(singlePurgedKeys.length, 1);
assert.equal(singlePurgedKeys[0], '557777777777.0');

// Trigger circuit breaker with 2 more errors for JID 557777777777
process.emit('unhandledRejection', keyErr);
process.emit('unhandledRejection', keyErr);
await new Promise(r => setTimeout(r, 50));
assert.equal(circuitBreakerWipes.length, 1);
assert.equal(circuitBreakerWipes[0], '557777777777');

// With _recentlyPurged properly cleared by base JID matching, a new single key purge for 557777777777.0 is allowed immediately
process.emit('unhandledRejection', keyErr);
await new Promise(r => setTimeout(r, 50));
assert.equal(singlePurgedKeys.length, 2, 'Single key purge should be permitted after circuit breaker clears _recentlyPurged by base JID');
console.log('✅ Test 6 Passed: _recentlyPurged Key ID Matching OK');

uninstallBadMacInterceptor();

console.log('🎉 All Worker 1 & Worker 2 Verification Tests Passed Successfully!');

