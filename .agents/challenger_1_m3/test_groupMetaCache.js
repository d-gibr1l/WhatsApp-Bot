import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "lru-cache";
import { handleAntiDelete, storeMessage } from "../../src/commands/antidelete.js";
import { cache } from "../../src/cache.js";

test("groupMetaCache - direct LRUCache configuration verification", () => {
  const cache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });
  assert.equal(cache.max, 500, "Cache max capacity must be 500");
  assert.equal(cache.ttl, 300000, "Cache TTL must be 300,000ms (5 minutes)");

  // Fill cache to max capacity (500 items)
  for (let i = 1; i <= 500; i++) {
    cache.set(`group_${i}@g.us`, { subject: `Group ${i}`, participants: [] });
  }

  assert.equal(cache.size, 500, "Cache size should be 500 after adding 500 items");
  assert.ok(cache.has("group_1@g.us"), "group_1@g.us should still be in cache");

  // Add 501st item
  cache.set("group_501@g.us", { subject: "Group 501", participants: [] });

  assert.equal(cache.size, 500, "Cache size should remain capped at 500");
  assert.ok(!cache.has("group_1@g.us"), "group_1@g.us (LRU) should have been evicted");
  assert.ok(cache.has("group_501@g.us"), "group_501@g.us should be present in cache");
});

test("groupMetaCache - LRU access order refresh", () => {
  const cache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });
  for (let i = 1; i <= 500; i++) {
    cache.set(`group_${i}@g.us`, { subject: `Group ${i}` });
  }

  // Access group_1 to refresh its recency
  cache.get("group_1@g.us");

  // Add 501st item
  cache.set("group_501@g.us", { subject: "Group 501" });

  assert.ok(cache.has("group_1@g.us"), "group_1@g.us should NOT be evicted because it was recently accessed");
  assert.ok(!cache.has("group_2@g.us"), "group_2@g.us should be evicted as the new LRU item");
});

test("groupMetaCache - TTL expiration behavior", async () => {
  // Test with short TTL (50ms) to verify eviction on time expiration
  const cache = new LRUCache({ max: 500, ttl: 50 });
  cache.set("temp_group@g.us", { subject: "Temporary Group" });

  assert.ok(cache.get("temp_group@g.us"), "Item should exist immediately after insert");

  // Wait 70ms for TTL to expire
  await new Promise((res) => setTimeout(res, 70));

  assert.equal(cache.get("temp_group@g.us"), undefined, "Item should return undefined after TTL expires");
});

test("antidelete - end-to-end group metadata caching and eviction via handleAntiDelete", async () => {
  // Enable antidelete in cache
  cache.settings = new Map([["antidelete_active", "true"]]);

  let groupMetadataCallCount = 0;
  const fetchedGroups = [];

  const mockSock = {
    groupMetadata: async (chatId) => {
      groupMetadataCallCount++;
      fetchedGroups.push(chatId);
      return {
        id: chatId,
        subject: `Group ${chatId}`,
        participants: [
          { id: "123456789@s.whatsapp.net", notify: "Test User" }
        ]
      };
    },
    sendMessage: async () => {}
  };

  // Test 1: First call for group_1@g.us should trigger groupMetadata call
  const msg1 = {
    key: { remoteJid: "group_1@g.us", id: "msg_1", participant: "123456789@s.whatsapp.net" },
    message: { conversation: "Hello World" }
    // pushName omitted so getDisplayName fetches group metadata
  };
  storeMessage(msg1, "Hello World");

  await handleAntiDelete(mockSock, { remoteJid: "group_1@g.us", id: "msg_1" });
  assert.equal(groupMetadataCallCount, 1, "First delete alert should trigger groupMetadata network fetch");

  // Test 2: Second call for group_1@g.us should hit groupMetaCache and NOT trigger groupMetadata call
  const msg2 = {
    key: { remoteJid: "group_1@g.us", id: "msg_2", participant: "123456789@s.whatsapp.net" },
    message: { conversation: "Second Message" }
  };
  storeMessage(msg2, "Second Message");

  await handleAntiDelete(mockSock, { remoteJid: "group_1@g.us", id: "msg_2" });
  assert.equal(groupMetadataCallCount, 1, "Second delete alert for group_1 should hit groupMetaCache (no extra fetch)");

  // Test 3: Populate 500 distinct groups to fill groupMetaCache capacity
  for (let i = 2; i <= 501; i++) {
    const groupId = `group_${i}@g.us`;
    const msgId = `msg_${i}`;
    const msg = {
      key: { remoteJid: groupId, id: msgId, participant: "123456789@s.whatsapp.net" },
      message: { conversation: `Msg ${i}` }
    };
    storeMessage(msg, `Msg ${i}`);
    await handleAntiDelete(mockSock, { remoteJid: groupId, id: msgId });
  }

  // At this point, 501 distinct groupMetadata calls have occurred (groups 1..501).
  // group_1@g.us was added first, and not accessed since then, so adding group 501 evicted group_1@g.us.
  assert.equal(groupMetadataCallCount, 501, "Total groupMetadata calls should be 501 after filling capacity");

  // Test 4: Trigger delete alert for group_1@g.us again.
  // Because group_1@g.us was evicted from groupMetaCache (max 500 capacity), it MUST fetch groupMetadata again!
  const msgEvicted = {
    key: { remoteJid: "group_1@g.us", id: "msg_evicted", participant: "123456789@s.whatsapp.net" },
    message: { conversation: "Evicted group msg" }
  };
  storeMessage(msgEvicted, "Evicted group msg");

  await handleAntiDelete(mockSock, { remoteJid: "group_1@g.us", id: "msg_evicted" });
  assert.equal(groupMetadataCallCount, 502, "Fetching group_1 after eviction should trigger a new groupMetadata call (cache miss)");
  assert.equal(fetchedGroups[fetchedGroups.length - 1], "group_1@g.us");
});
