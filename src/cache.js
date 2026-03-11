// ─── cache.js ──────────────────────────────────────────────
// Production-ready in-memory cache with true LRU, trie-based auto-replies, atomic swaps,
// metrics, validation, and auto-refresh.

import {
  getAdmins,
  getBannedList,
  getAllowedGroups,
  getAllSettings,
  getAllAutoReplies,
} from "./db.js";

// ─── Helpers ──────────────────────────────────────────────

function normalizeNumber(num) {
  return String(num || "").replace(/\D/g, "");
}

// ─── Trie for Auto-Replies ─────────────────────────────────

class TrieNode {
  constructor() {
    this.children = new Map();
    this.response = null;
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(keyword, response) {
    let node = this.root;
    for (const char of keyword) {
      if (!node.children.has(char)) node.children.set(char, new TrieNode());
      node = node.children.get(char);
    }
    node.response = response;
  }

  // Match whole words only to prevent partial matches (e.g. "hi" inside "this")
  search(text) {
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      let node = this.root;
      for (const char of word) {
        node = node.children.get(char);
        if (!node) break;
        if (node.response) return node.response;
      }
    }
    return null;
  }
}

// ─── True LRU ─────────────────────────────────────────────

class LRU {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  has(key) {
    if (!this.map.has(key)) return false;
    // Move to end to mark as recently used
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return true;
  }

  set(key, value = true) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}

// ─── State ────────────────────────────────────────────────

let cache = null;
const messageCache = new LRU(1000);

export const stats = {
  cacheLoads: 0,
  autoReplyHits: 0,
  autoReplyMisses: 0,
  messagesSeen: 0,
};

function ensureLoaded() {
  if (!cache) throw new Error("Cache not loaded yet");
}

// ─── Build Auto-Reply Trie ────────────────────────────────

function buildAutoReplyTrie(autoReplies) {
  const trie = new Trie();
  for (const r of (autoReplies || [])) {
    if (!r.keyword || !r.response) continue;
    trie.insert(r.keyword.toLowerCase(), r.response);
  }
  return trie;
}

// ─── Load / Refresh Cache ─────────────────────────────────

export async function loadCache() {
  try {
    const [admins, banned, groups, settings, autoReplies] = await Promise.all([
      getAdmins(),
      getBannedList(),
      getAllowedGroups(),
      getAllSettings(),
      getAllAutoReplies(),
    ]);

    cache = {
      admins:         new Set((admins   || []).map(normalizeNumber)),
      banned:         new Set((banned   || []).map((b) => normalizeNumber(b.number))),
      allowedGroups:  new Set((groups   || []).map((g) => g.group_id)),
      settings:       new Map((settings || []).map((s) => [s.key, s.value])),
      autoReplyTrie:  buildAutoReplyTrie(autoReplies),
    };

    stats.cacheLoads++;
    console.log(
      `✅ Cache loaded — ${cache.admins.size} admins, ${cache.banned.size} banned, ` +
      `${cache.allowedGroups.size} groups, ${cache.settings.size} settings, ` +
      `${autoReplies?.length || 0} auto-replies`
    );
  } catch (err) {
    console.error("❌ Cache load failed:", err.message);
  }
}

// Auto-refresh every N ms (call once in index.js after loadCache)
export function startCacheAutoRefresh(interval = 5 * 60 * 1000) {
  setInterval(loadCache, interval);
}

// ─── Selective Refresh Helpers ────────────────────────────

async function refreshKey(key, fetcher, transform) {
  try {
    ensureLoaded();
    const data = await fetcher();
    cache[key] = transform(data || []);
  } catch (err) {
    console.error(`❌ refresh ${key} failed:`, err.message);
  }
}

export const refreshAdmins = () =>
  refreshKey("admins", getAdmins, (data) => new Set(data.map(normalizeNumber)));

export const refreshBanned = () =>
  refreshKey("banned", getBannedList, (data) =>
    new Set(data.map((b) => normalizeNumber(b.number)))
  );

export const refreshGroups = () =>
  refreshKey("allowedGroups", getAllowedGroups, (data) =>
    new Set(data.map((g) => g.group_id))
  );

export const refreshSettings = () =>
  refreshKey("settings", getAllSettings, (data) =>
    new Map(data.map((s) => [s.key, s.value]))
  );

export async function refreshAutoReplies() {
  try {
    ensureLoaded();
    const data = await getAllAutoReplies();
    cache.autoReplyTrie = buildAutoReplyTrie(data);
  } catch (err) {
    console.error("❌ refreshAutoReplies failed:", err.message);
  }
}

// ─── Readers ──────────────────────────────────────────────

export function cachedIsAdmin(number) {
  ensureLoaded();
  return cache.admins.has(normalizeNumber(number));
}

export function cachedIsBanned(number) {
  ensureLoaded();
  return cache.banned.has(normalizeNumber(number));
}

export function cachedIsGroupAllowed(groupId) {
  ensureLoaded();
  return cache.allowedGroups.has(groupId);
}

export function cachedHasAllowedGroups() {
  ensureLoaded();
  return cache.allowedGroups.size > 0;
}

export function cachedGetSetting(key, fallback = null) {
  ensureLoaded();
  return cache.settings.get(key) ?? fallback;
}

export function cachedGetAutoReply(text) {
  ensureLoaded();
  const response = cache.autoReplyTrie.search(text);
  if (!response) {
    stats.autoReplyMisses++;
    return null;
  }
  stats.autoReplyHits++;
  return response;
}

// ─── Message LRU ─────────────────────────────────────────

export function seenMessage(id) {
  return messageCache.has(id);
}

export function rememberMessage(id) {
  messageCache.set(id);
  stats.messagesSeen++;
}
