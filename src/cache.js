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
import { getRedis } from "./auth/redisSession.js";

// ─── Redis for message deduplication ──────────────────────
let _dedupRedis = null;
const DEDUP_PREFIX = "seen_msg:";
const DEDUP_TTL = 3600; // 1 hour

function getDedupRedis() {
  return getRedis();
}

// ─── Helpers ──────────────────────────────────────────────

function normalizeNumber(num) {
  return String(num || "").replace(/\D/g, "");
}

// ─── Trie for Auto-Replies (Word-Based) ───────────────────

export class TrieNode {
  constructor() {
    this.children = new Map();
    this.response = null;
  }
}

export class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(keyword, response) {
    const words = keyword.toLowerCase().replace(/[.,?!;:()'"]/g, "").split(/\s+/);
    let node = this.root;
    for (const word of words) {
      if (!node.children.has(word)) node.children.set(word, new TrieNode());
      node = node.children.get(word);
    }
    node.response = response;
  }

  search(text) {
    const words = text.toLowerCase().replace(/[.,?!;:()'"]/g, "").split(/\s+/);
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
    const results = await Promise.allSettled([
      getAdmins(),
      getBannedList(),
      getAllowedGroups(),
      getAllSettings(),
      getAllAutoReplies(),
    ]);

    const getValue = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;

    const admins = getValue(results[0], []);
    const banned = getValue(results[1], []);
    const groups = getValue(results[2], []);
    const settings = getValue(results[3], []);
    const autoReplies = getValue(results[4], []);

    if (!cache.admins) cache.admins = new Set();
    cache.admins.clear();
    (admins || []).forEach((a) => cache.admins.add(normalizeNumber(a)));

    if (!cache.banned) cache.banned = new Set();
    cache.banned.clear();
    (banned || []).forEach((b) => cache.banned.add(normalizeNumber(b.number)));

    if (!cache.allowedGroups) cache.allowedGroups = new Set();
    cache.allowedGroups.clear();
    (groups || []).forEach((g) => cache.allowedGroups.add(g.group_id));

    if (!cache.settings) cache.settings = new Map();
    cache.settings.clear();
    (settings || []).forEach((s) => cache.settings.set(s.key, s.value));

    if (!cache.autoReplyTrie) cache.autoReplyTrie = new Trie();
    cache.autoReplyTrie.root = buildAutoReplyTrie(autoReplies).root;

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
          if (!fallbackInterval) fallbackInterval = setInterval(loadCache, 5 * 60 * 1000);
        }
      });
      
    safetyInterval = setInterval(loadCache, 10 * 60 * 1000);
  } catch (err) {
    console.warn(`⚠️ Supabase Realtime unavailable (${err.message}) — falling back to 5m polling`);
    fallbackInterval = setInterval(loadCache, 5 * 60 * 1000);
  }
}

// ─── Selective Refresh Helpers ────────────────────────────

export async function refreshAdmins() {
  try {
    const data = await getAdmins();
    if (!cache.admins) cache.admins = new Set();
    cache.admins.clear();
    (data || []).forEach((a) => cache.admins.add(normalizeNumber(a)));
  } catch (err) {
    console.error("❌ refresh admins failed:", err.message);
  }
}

export async function refreshBanned() {
  try {
    const data = await getBannedList();
    if (!cache.banned) cache.banned = new Set();
    cache.banned.clear();
    (data || []).forEach((b) => cache.banned.add(normalizeNumber(b.number)));
  } catch (err) {
    console.error("❌ refresh banned failed:", err.message);
  }
}

export async function refreshGroups() {
  try {
    const data = await getAllowedGroups();
    if (!cache.allowedGroups) cache.allowedGroups = new Set();
    cache.allowedGroups.clear();
    (data || []).forEach((g) => cache.allowedGroups.add(g.group_id));
  } catch (err) {
    console.error("❌ refresh groups failed:", err.message);
  }
}

export async function refreshSettings() {
  try {
    const data = await getAllSettings();
    if (!cache.settings) cache.settings = new Map();
    cache.settings.clear();
    (data || []).forEach((s) => cache.settings.set(s.key, s.value));
  } catch (err) {
    console.error("❌ refresh settings failed:", err.message);
  }
}

export async function refreshAutoReplies() {
  try {
    const data = await getAllAutoReplies();
    if (!cache.autoReplyTrie) cache.autoReplyTrie = new Trie();
    cache.autoReplyTrie.root = buildAutoReplyTrie(data).root;
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
  if (cache.settings && cache.settings.has(key)) {
    return cache.settings.get(key);
  }
  return fallback;
}

export function cachedGetAutoReply(text) {
  const response = cache.autoReplyTrie.search(text);
  if (!response) { stats.autoReplyMisses++; return null; }
  stats.autoReplyHits++;
  return response;
}

// ─── LRU Message Trackers (Redis-backed for restart persistence) ──

export async function loadSeenMessages() {
  try {
    const redis = getDedupRedis();
    let cursor = '0';
    let count = 0;
    
    // Safely paginate through the keys instead of pulling a massive array at once
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${DEDUP_PREFIX}*`, 'COUNT', 200);
      cursor = nextCursor;
      for (const k of keys) {
        const id = k.replace(DEDUP_PREFIX, "");
        messageCache.set(id, true);
        count++;
      }
    } while (cursor !== '0');
    
    console.log(`✅ Loaded ${count} seen message IDs from Redis`);
  } catch (err) {
    console.warn("⚠️ Could not load seen messages from Redis:", err.message);
  }
}

export function seenMessage(id) {
  return messageCache.has(id);
}

export function rememberMessage(id) {
  messageCache.set(id, true);
  stats.messagesSeen++;
  
  // Fire-and-forget write to Redis using isolated keys with an exact TTL
  try {
    const redis = getDedupRedis();
    redis.set(`${DEDUP_PREFIX}${id}`, "1", "EX", DEDUP_TTL).catch(() => {});
  } catch {}
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