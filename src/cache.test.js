import { test } from 'node:test';
import assert from 'node:assert';
import { Trie, cache, cachedGetSetting } from './cache.js';

test('Trie basic insertion and search', () => {
  const trie = new Trie();
  trie.insert('hello bot', 'Hello there!');
  
  // Exact match
  assert.strictEqual(trie.search('hello bot'), 'Hello there!');
  
  // Mixed case
  assert.strictEqual(trie.search('HELLO BOT'), 'Hello there!');
  assert.strictEqual(trie.search('Hello bOT'), 'Hello there!');
  
  // Embedded in larger text
  assert.strictEqual(trie.search('Hey guys, hello bot, how are you?'), 'Hello there!');
  assert.strictEqual(trie.search('hello bot is great'), 'Hello there!');
});

test('Trie handles punctuation', () => {
  const trie = new Trie();
  // Insert with punctuation
  trie.insert('hello, bot!', 'Hi!');
  
  // Should strip punctuation during search and insert
  assert.strictEqual(trie.search('hello bot'), 'Hi!');
  assert.strictEqual(trie.search('hello, bot!'), 'Hi!');
  assert.strictEqual(trie.search('hello??? bot!!'), 'Hi!');
});

test('Trie search returns null when not found', () => {
  const trie = new Trie();
  trie.insert('good morning', 'Morning!');
  
  assert.strictEqual(trie.search('good'), null);
  assert.strictEqual(trie.search('morning'), null);
  assert.strictEqual(trie.search('good night'), null);
  assert.strictEqual(trie.search('hello'), null);
});

test('Trie prioritizes first match found in text', () => {
  const trie = new Trie();
  trie.insert('apple', 'Fruit');
  trie.insert('apple pie', 'Dessert');
  
  // When inserting 'apple' and 'apple pie', 'apple' matches first because
  // the outer loop starts at index 0 and finds 'apple' at index 0.
  assert.strictEqual(trie.search('i like apple pie'), 'Fruit');
});

test('cachedGetSetting retrieves existing settings', () => {
  // Setup cache
  cache.settings = new Map();
  cache.settings.set('bot_prefix', '!');
  cache.settings.set('bot_active', 'true');
  
  assert.strictEqual(cachedGetSetting('bot_prefix'), '!');
  assert.strictEqual(cachedGetSetting('bot_active'), 'true');
});

test('cachedGetSetting returns fallback for missing settings', () => {
  cache.settings = new Map();
  
  assert.strictEqual(cachedGetSetting('missing_key'), null);
  assert.strictEqual(cachedGetSetting('missing_key', 'default_value'), 'default_value');
});

test('cachedGetSetting handles missing cache gracefully', () => {
  // Simulate missing settings map
  cache.settings = null;
  
  assert.strictEqual(cachedGetSetting('any_key'), null);
  assert.strictEqual(cachedGetSetting('any_key', 'fallback'), 'fallback');
});
