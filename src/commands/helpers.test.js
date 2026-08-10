import { test } from 'node:test';
import assert from 'node:assert';
import { parseTime } from './helpers.js';

test('parseTime handles valid inputs', () => {
  assert.strictEqual(parseTime("10s"), 10000);
  assert.strictEqual(parseTime("2m"), 120000);
  assert.strictEqual(parseTime("1h"), 3600000);
  assert.strictEqual(parseTime("1.5h"), 5400000);
  assert.strictEqual(parseTime(" 1 d "), 86400000);
  assert.strictEqual(parseTime("5S"), 5000);
  assert.strictEqual(parseTime(".5m"), 30000);
  assert.strictEqual(parseTime("0.5m"), 30000);
});

test('parseTime handles invalid inputs', () => {
  assert.strictEqual(parseTime(""), null);
  assert.strictEqual(parseTime("10"), null);
  assert.strictEqual(parseTime("s"), null);
  assert.strictEqual(parseTime("10x"), null);
  assert.strictEqual(parseTime("10sm"), null);
  assert.strictEqual(parseTime("abc"), null);
  assert.strictEqual(parseTime(null), null);
  assert.strictEqual(parseTime(10), null);
});
