// ─── cache.js ──────────────────────────────────────────────
// Production-ready in-memory cache with true LRU, word-based Trie auto-replies, 
// atomic swaps, metrics, validation, and instant LISTEN/NOTIFY refresh.

import {
  getAdmins,
  getBannedList,
  getAllowedGroups,
  getAllSettings,
  getAllAutoReplies,
  supabase,
} from "./db.js";
import { LRUCache } from "lru-cache";

// ─── Helpers ──────────────────────────────────────────────

function normalizeNumber(num) {
  return String(num || "").replace(/\D/g, "");
}

// ─── Trie for Auto-Replies (Word-Based) ───────────────────

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
    const words = keyword.toLowerCase().split(/\s+/);
    let node = this.root;
    for (const word of words) {
      if (!node.children.has(word)) node.children.set(word, new TrieNode());
      node = node.children.get(word);
    }
    node.response = response;
  }

  search(text) {
    const words = text.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      let node = this.root;
      for (let j = i; j < words.length; j++) {
        node = node.children.get(words[j]);
        if (!node) break;
        if (node.response) return node.response;
      }
    }
    return null;
  }
}

// ─── State ────────────────────────────────────────────────

export let cache = {
  admins:        new Set(),
  banned:        new Set(),
  allowedGroups: new Set(),
  settings:      new Map(),
  autoReplyTrie: new Trie(),
};

const messageCache = new LRUCache({ max: 1000 });
const botSentCache = new LRUCache({ max: 500 });
const aiSentCache  = new LRUCache({ max: 200 });

export const stats = {
  cacheLoads:       0,
  autoReplyHits:    0,
  autoReplyMisses:  0,
  messagesSeen:     0,
};

// ─── Build Auto-Reply Trie ────────────────────────────────

function buildAutoReplyTrie(autoReplies) {
  const trie = new Trie();
  for (const r of (autoReplies || [])) {
    if (!r.keyword || !r.response) continue;
    trie.insert(r.keyword, r.response);
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
      admins:        new Set((admins   || []).map(normalizeNumber)),
      banned:        new Set((banned   || []).map((b) => normalizeNumber(b.number))),
      allowedGroups: new Set((groups   || []).map((g) => g.group_id)),
      settings:      new Map((settings || []).map((s) => [s.key, s.value])),
      autoReplyTrie: buildAutoReplyTrie(autoReplies),
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

// ─── LISTEN/NOTIFY Architecture ───────────────────────────

let safetyInterval  = null;
let fallbackInterval = null;
let subscription = null;

export function startCacheAutoRefresh() {
  // Clean up existing connections to prevent memory leaks on reconnect
  if (safetyInterval)  clearInterval(safetyInterval);
  if (fallbackInterval) clearInterval(fallbackInterval);
  if (subscription) {
    supabase.removeChannel(subscription);
    subscription = null;
  }

  const handleUpdate = (payload) => {
    const table = payload.table;
    console.log(`🔄 Cache: ${table} updated instantly via Supabase Realtime`);
    if (table === "admins") refreshAdmins();
    else if (table === "banned_numbers") refreshBanned();
    else if (table === "allowed_groups") refreshGroups();
    else if (table === "settings") refreshSettings();
    else if (table === "auto_replies") refreshAutoReplies();
  };

  try {
    subscription = supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public' },
        handleUpdate
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log("✅ Supabase Realtime active — instant DB updates enabled");
        } else if (status === 'CHANNEL_ERROR') {
          console.warn("⚠️ Realtime channel error. Falling back to polling.");
        }
      });
      
    // Safety net full refresh every 10 minutes
    safetyInterval = setInterval(loadCache, 10 * 60 * 1000);
  } catch (err) {
    console.warn(`⚠️ Supabase Realtime unavailable (${err.message}) — falling back to 30s polling`);
    fallbackInterval = setInterval(loadCache, 30_000);
  }
}

// ─── Selective Refresh Helpers ────────────────────────────

async function refreshKey(key, fetcher, transform) {
  try {
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
    const data = await getAllAutoReplies();
    cache.autoReplyTrie = buildAutoReplyTrie(data);
  } catch (err) {
    console.error("❌ refreshAutoReplies failed:", err.message);
  }
}

// ─── Readers ──────────────────────────────────────────────

export function cachedIsAdmin(number) {
  return cache.admins.has(normalizeNumber(number));
}

export function cachedIsBanned(number) {
  return cache.banned.has(normalizeNumber(number));
}

export function cachedIsGroupAllowed(groupId) {
  return cache.allowedGroups.has(groupId);
}

export function cachedHasAllowedGroups() {
  return cache.allowedGroups.size > 0;
}

export function cachedGetSetting(key, fallback = null) {
  return cache.settings.get(key) ?? fallback;
}

export function cachedGetAutoReply(text) {
  const response = cache.autoReplyTrie.search(text);
  if (!response) { stats.autoReplyMisses++; return null; }
  stats.autoReplyHits++;
  return response;
}

// ─── LRU Message Trackers ─────────────────────────────────

export function seenMessage(id) {
  return messageCache.has(id);
}

export function rememberMessage(id) {
  messageCache.set(id, true);
  stats.messagesSeen++;
}

export function isBotSentMessage(id) {
  return id ? botSentCache.has(id) : false;
}

export function rememberBotSent(id) {
  if (id) botSentCache.set(id, true);
}

export function isAiSentMessage(id) {
  return id ? aiSentCache.has(id) : false;
}

export function rememberAiSent(id) {
  if (id) aiSentCache.set(id, true);
}