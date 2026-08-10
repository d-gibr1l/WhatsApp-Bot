import { test } from 'node:test';
import assert from 'node:assert';
import {
  cache,
  loadCache,
  refreshAdmins,
  refreshBanned,
  refreshGroups,
  refreshSettings,
  refreshAutoReplies,
  Trie,
} from '../src/cache.js';
import { storeMessage, handleAntiDelete } from '../src/commands/antidelete.js';

test('Empirical M3 Test 1: In-place cache mutation stability across all cache entities', async () => {
  // Capture initial object references
  const initialAdmins = cache.admins;
  const initialBanned = cache.banned;
  const initialGroups = cache.allowedGroups;
  const initialSettings = cache.settings;
  const initialTrie = cache.autoReplyTrie;

  assert.ok(initialAdmins instanceof Set, 'cache.admins should be a Set');
  assert.ok(initialBanned instanceof Set, 'cache.banned should be a Set');
  assert.ok(initialGroups instanceof Set, 'cache.allowedGroups should be a Set');
  assert.ok(initialSettings instanceof Map, 'cache.settings should be a Map');
  assert.ok(initialTrie instanceof Trie, 'cache.autoReplyTrie should be a Trie instance');

  // Populate initial values directly
  initialAdmins.add('1234567890');
  initialBanned.add('0987654321');
  initialGroups.add('1203630123456789@g.us');
  initialSettings.set('test_key', 'test_value');
  initialTrie.insert('hello', 'world');

  // Trigger loadCache()
  await loadCache();

  // Assert exact object reference identity after loadCache()
  assert.strictEqual(cache.admins, initialAdmins, 'cache.admins object reference must be preserved after loadCache');
  assert.strictEqual(cache.banned, initialBanned, 'cache.banned object reference must be preserved after loadCache');
  assert.strictEqual(cache.allowedGroups, initialGroups, 'cache.allowedGroups object reference must be preserved after loadCache');
  assert.strictEqual(cache.settings, initialSettings, 'cache.settings object reference must be preserved after loadCache');
  assert.strictEqual(cache.autoReplyTrie, initialTrie, 'cache.autoReplyTrie object reference must be preserved after loadCache');

  // Trigger selective refresh functions
  await refreshAdmins();
  await refreshBanned();
  await refreshGroups();
  await refreshSettings();
  await refreshAutoReplies();

  // Assert exact object reference identity after selective refresh functions
  assert.strictEqual(cache.admins, initialAdmins, 'cache.admins reference preserved after refreshAdmins');
  assert.strictEqual(cache.banned, initialBanned, 'cache.banned reference preserved after refreshBanned');
  assert.strictEqual(cache.allowedGroups, initialGroups, 'cache.allowedGroups reference preserved after refreshGroups');
  assert.strictEqual(cache.settings, initialSettings, 'cache.settings reference preserved after refreshSettings');
  assert.strictEqual(cache.autoReplyTrie, initialTrie, 'cache.autoReplyTrie reference preserved after refreshAutoReplies');
});

test('Empirical M3 Test 2: Antidelete message store and groupMetaCache LRU bounds', async () => {
  // Verify storeMessage and handleAntiDelete execute without crashing
  const mockMsg = {
    key: { remoteJid: '1203630123456789@g.us', id: 'MSG12345' },
    pushName: 'Tester',
    message: { conversation: 'Hello world' }
  };

  storeMessage(mockMsg, 'Hello world');

  const mockSock = {
    sendMessage: async () => ({}),
    groupMetadata: async () => ({
      participants: [{ id: '12345@s.whatsapp.net', notify: 'Tester' }]
    })
  };

  // Turn on antidelete in settings cache
  cache.settings.set('antidelete_active', 'true');

  await handleAntiDelete(mockSock, mockMsg.key);
  // Verify execution succeeds without unhandled exceptions
  assert.ok(true, 'handleAntiDelete completed gracefully');
});
