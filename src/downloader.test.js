import { test } from 'node:test';
import assert from 'node:assert';
import { extractUrl, detectPlatform, getYtDlpPath, getCookiesPath } from './downloader.js';
import { promises as fsPromises } from 'fs';
import { db } from './db.js';

test('extractUrl extracts valid URLs', () => {
  assert.strictEqual(extractUrl('Check this out: https://google.com'), 'https://google.com');
  assert.strictEqual(extractUrl('http://example.com is a website'), 'http://example.com');
  assert.strictEqual(extractUrl('No spaces here:https://example.org'), 'https://example.org');
});

test('extractUrl returns null for invalid or empty inputs', () => {
  assert.strictEqual(extractUrl(''), null);
  assert.strictEqual(extractUrl(null), null);
  assert.strictEqual(extractUrl(undefined), null);
  assert.strictEqual(extractUrl('Just some text without links'), null);
});

test('extractUrl returns the first URL if multiple exist', () => {
  assert.strictEqual(
    extractUrl('First: https://first.com, Second: https://second.com'),
    'https://first.com'
  );
});

test('extractUrl correctly strips trailing punctuation', () => {
  assert.strictEqual(extractUrl('Have you seen https://google.com?'), 'https://google.com');
  assert.strictEqual(extractUrl('I like https://google.com.'), 'https://google.com');
  assert.strictEqual(extractUrl('Go to https://google.com, it is great.'), 'https://google.com');
  assert.strictEqual(extractUrl('Link (https://google.com)'), 'https://google.com');
});

test('detectPlatform correctly identifies platforms', () => {
  assert.strictEqual(detectPlatform('https://youtube.com/watch?v=123'), 'youtube');
  assert.strictEqual(detectPlatform('https://youtu.be/123'), 'youtube');
  assert.strictEqual(detectPlatform('https://www.tiktok.com/@user/video/123'), 'tiktok');
  assert.strictEqual(detectPlatform('https://instagram.com/p/123'), 'instagram');
  assert.strictEqual(detectPlatform('https://x.com/status/123'), 'twitter');
  assert.strictEqual(detectPlatform('https://reddit.com/r/videos/123'), 'reddit');
  assert.strictEqual(detectPlatform('https://b23.tv/123'), 'bilibili');
});

test('detectPlatform returns null for unknown platforms or invalid inputs', () => {
  assert.strictEqual(detectPlatform('https://unknown-website.com'), null);
  assert.strictEqual(detectPlatform(''), null);
  assert.strictEqual(detectPlatform(null), null);
});

test('getYtDlpPath returns a string path', () => {
  const path = getYtDlpPath();
  assert.strictEqual(typeof path, 'string');
  assert.ok(path.length > 0);
});

test('getCookiesPath returns null if fsPromises.writeFile throws', async (t) => {
  t.mock.method(db, 'getSetting', async () => 'some_cookie_data');
  t.mock.method(fsPromises, 'writeFile', async () => {
    throw new Error('Disk full');
  });

  const result = await getCookiesPath();
  assert.strictEqual(result, null);
});

test('getCookiesPath returns null if getSetting throws', async (t) => {
  t.mock.method(db, 'getSetting', async () => {
    throw new Error('DB Error');
  });

  const result = await getCookiesPath();
  assert.strictEqual(result, null);
});
