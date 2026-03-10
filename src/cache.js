// ─── In-Memory Cache ──────────────────────────────────────────────────────────
// Loads frequently accessed data once and keeps it in memory.
// Cache is invalidated and refreshed when admin commands change data.

import {
  getAdmins, getBannedList, getAllowedGroups,
  getAllSettings, getAllAutoReplies,
} from "./db.js";

const cache = {
  admins: new Set(),
  banned: new Set(),
  allowedGroups: new Set(),
  settings: new Map(),
  autoReplies: [],
  loaded: false,
};

// ─── Load / Refresh ───────────────────────────────────────────────────────────

export async function loadCache() {
  try {
    const [admins, banned, groups, settings, autoReplies] = await Promise.all([
      getAdmins(),
      getBannedList(),
      getAllowedGroups(),
      getAllSettings(),
      getAllAutoReplies(),
    ]);

    cache.admins    = new Set(admins);
    cache.banned    = new Set(banned.map((b) => b.number));
    cache.allowedGroups = new Set(groups.map((g) => g.group_id));
    cache.settings  = new Map(settings.map((s) => [s.key, s.value]));
    cache.autoReplies = autoReplies;
    cache.loaded    = true;

    console.log(`✅ Cache loaded — ${cache.admins.size} admins, ${cache.banned.size} banned, ${cache.allowedGroups.size} groups, ${cache.settings.size} settings`);
  } catch (err) {
    console.error("❌ Failed to load cache:", err.message);
  }
}

// ─── Refresh Helpers (call after DB writes) ───────────────────────────────────

export async function refreshAdmins() {
  const admins = await getAdmins();
  cache.admins = new Set(admins);
}

export async function refreshBanned() {
  const banned = await getBannedList();
  cache.banned = new Set(banned.map((b) => b.number));
}

export async function refreshGroups() {
  const groups = await getAllowedGroups();
  cache.allowedGroups = new Set(groups.map((g) => g.group_id));
}

export async function refreshSettings() {
  const settings = await getAllSettings();
  cache.settings = new Map(settings.map((s) => [s.key, s.value]));
}

export async function refreshAutoReplies() {
  cache.autoReplies = await getAllAutoReplies();
}

// ─── Cache Readers (used in handler.js instead of DB calls) ──────────────────

export function cachedIsAdmin(number) {
  return cache.admins.has(number);
}

export function cachedIsBanned(number) {
  return cache.banned.has(number);
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
  const lower = text.toLowerCase();
  const match = cache.autoReplies.find((r) => lower.includes(r.keyword));
  return match?.response ?? null;
}
