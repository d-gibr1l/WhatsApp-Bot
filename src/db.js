import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import fs from "fs/promises";
import path from "path";

function createMockClient() {
  const errorObj = { data: null, error: new Error("Supabase is not configured. Please set SUPABASE_URL and SUPABASE_KEY in the environment.") };
  const chain = {
    select: () => chain,
    eq: () => chain,
    lte: () => chain,
    lt: () => chain,
    order: () => chain,
    range: () => chain,
    in: () => chain,
    single: async () => ({ data: null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    insert: async () => errorObj,
    upsert: async () => errorObj,
    delete: () => {
      const errChain = {
        eq: () => errChain,
        in: () => errChain,
        lt: () => errChain,
        lte: () => errChain,
        then: (resolve) => resolve(errorObj)
      };
      return errChain;
    },
    update: () => {
      const errChain = {
        eq: () => errChain,
        then: (resolve) => resolve(errorObj)
      };
      return errChain;
    },
    then: (resolve) => resolve({ data: [], error: null })
  };
  return {
    from: () => chain,
    removeChannel: () => {},
    channel: () => ({
      on: () => ({
        subscribe: (cb) => { if (cb) cb('CHANNEL_ERROR'); }
      })
    })
  };
}

import WebSocket from "ws";

export const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: false
      },
      realtime: {
        transport: WebSocket
      }
    })
  : createMockClient();

// ─── Bulk Loaders (used strictly by cache.js to populate RAM) ─────────────────

export async function getAdmins() {
  try {
    const { data, error } = await supabase.from("admins").select("number");
    if (error) throw error;
    return data.map((r) => r.number);
  } catch (err) {
    console.error("❌ getAdmins:", err.message);
    return [];
  }
}

export async function getAllSettings() {
  try {
    const { data, error } = await supabase.from("settings").select("key, value");
    if (error) throw error;
    return data;
  } catch (err) {
    console.error("❌ getAllSettings:", err.message);
    return [];
  }
}

export async function getBannedList() {
  try {
    const { data, error } = await supabase.from("banned_numbers").select("number, reason");
    if (error) throw error;
    return data;
  } catch (err) {
    console.error("❌ getBannedList:", err.message);
    return [];
  }
}

export async function getAllowedGroups() {
  try {
    const { data, error } = await supabase.from("allowed_groups").select("group_id, name");
    if (error) throw error;
    return data;
  } catch (err) {
    console.error("❌ getAllowedGroups:", err.message);
    return [];
  }
}

export async function getAllAutoReplies() {
  try {
    const { data, error } = await supabase.from("auto_replies").select("keyword, response");
    if (error) throw error;
    return data;
  } catch (err) {
    console.error("❌ getAllAutoReplies:", err.message);
    return [];
  }
}

// ─── Single setting/status read ──────────────────────────────────────────────

export async function getSetting(key, fallback = null) {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", key)
      .single();
    if (error || !data) return fallback;
    return data.value;
  } catch {
    return fallback;
  }
}

export const db = { getSetting };

export async function isBanned(number) {
  try {
    const { data, error } = await supabase
      .from("banned_numbers")
      .select("number")
      .eq("number", number)
      .maybeSingle();
    if (error) throw error;
    return !!data; // Returns true if data exists, false otherwise
  } catch (err) {
    console.error("❌ isBanned:", err.message);
    return false;
  }
}

// ─── Mutations (Writes) ───────────────────────────────────────────────────────

export async function addAdmin(number) {
  const { error } = await supabase.from("admins").upsert({ number }, { onConflict: "number" });
  if (error) throw error;
}

export async function removeAdmin(number) {
  const { error } = await supabase.from("admins").delete().eq("number", number);
  if (error) throw error;
}

export async function setSetting(key, value) {
  const { error } = await supabase
    .from("settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

export async function banNumber(number, reason = "No reason given") {
  const { error } = await supabase
    .from("banned_numbers")
    .upsert({ number, reason }, { onConflict: "number" });
  if (error) throw error;
}

export async function unbanNumber(number) {
  const { error } = await supabase.from("banned_numbers").delete().eq("number", number);
  if (error) throw error;
}

export async function allowGroup(groupId, name = "") {
  const { error } = await supabase
    .from("allowed_groups")
    .upsert({ group_id: groupId, name }, { onConflict: "group_id" });
  if (error) throw error;
}

export async function removeGroup(groupId) {
  const { error } = await supabase.from("allowed_groups").delete().eq("group_id", groupId);
  if (error) throw error;
}

export async function addAutoReply(keyword, response) {
  const { error } = await supabase
    .from("auto_replies")
    .upsert({ keyword: keyword.toLowerCase(), response }, { onConflict: "keyword" });
  if (error) throw error;
}

export async function removeAutoReply(keyword) {
  const { error } = await supabase
    .from("auto_replies")
    .delete()
    .eq("keyword", keyword.toLowerCase());
  if (error) throw error;
}

export async function warnUser(number, reason = "No reason given") {
  const { data } = await supabase
    .from("warnings")
    .select("count, reasons")
    .eq("number", number)
    .single();
  const count   = (data?.count ?? 0) + 1;
  const reasons = [...(data?.reasons ?? []), reason];
  const { error } = await supabase
    .from("warnings")
    .upsert({ number, count, reasons }, { onConflict: "number" });
  if (error) throw error;
  return count;
}

export async function getWarnings(number) {
  try {
    const { data, error } = await supabase
      .from("warnings")
      .select("count, reasons")
      .eq("number", number)
      .single();
    if (error || !data) return { count: 0, reasons: [] };
    return data;
  } catch {
    return { count: 0, reasons: [] };
  }
}

export async function clearWarnings(number) {
  const { error } = await supabase.from("warnings").delete().eq("number", number);
  if (error) throw error;
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export async function addReminder(number, chatId, message, fireAt) {
  const { error } = await supabase
    .from("reminders")
    .insert({ number, chat_id: chatId, message, fire_at: fireAt, done: false });
  if (error) throw error;
}

export async function getPendingReminders() {
  try {
    const { data, error } = await supabase
      .from("reminders")
      .select("*")
      .eq("done", false)
      .lte("fire_at", new Date().toISOString());
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    console.error("❌ getPendingReminders:", err.message);
    return [];
  }
}

export async function markReminderDone(id) {
  await supabase.from("reminders").update({ done: true }).eq("id", id);
}

// ─── Anti-Delete Store ────────────────────────────────────────────────────────

export async function storeAntiDeletePayload(id, chatId, sender, pushName, payload) {
  const { error } = await supabase
    .from("antidelete_store")
    .upsert({ id, chat_id: chatId, sender, push_name: pushName, payload }, { onConflict: "id" });
  if (error) console.error("❌ storeAntiDeletePayload error:", error.message);
}

export async function getAntiDeletePayload(id) {
  try {
    const { data, error } = await supabase
      .from("antidelete_store")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error("❌ getAntiDeletePayload error:", err.message);
    return null;
  }
}

export async function cleanupAntiDeleteStore() {
  // Delete messages older than 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("antidelete_store")
    .delete()
    .lt("created_at", sevenDaysAgo);
  if (error) console.error("❌ cleanupAntiDeleteStore error:", error.message);
}

// ─── Buffered Stats Logging ───────────────────────────────────────────────────

let logBuffer = [];
let isFlushingLogs = false;
const MAX_BUFFER_SIZE = 2000;

export function logMessage(number, chatId, isGroup) {
  if (logBuffer.length >= MAX_BUFFER_SIZE) return;
  logBuffer.push({
    number,
    chat_id:  chatId,
    is_group: isGroup,
    sent_at:  new Date().toISOString(),
  });
}

const flushTimer = setInterval(async () => {
  if (logBuffer.length === 0 || isFlushingLogs) return;
  isFlushingLogs = true;
  const batch = [...logBuffer];
  logBuffer = [];
  try {
    const { error } = await supabase.from("message_logs").insert(batch);
    if (error) throw error;
  } catch (err) {
    console.error(`❌ Failed to flush ${batch.length} message logs:`, err.message);
    logBuffer = [...batch, ...logBuffer].slice(0, MAX_BUFFER_SIZE);
  } finally {
    isFlushingLogs = false;
  }
}, 5000);
flushTimer.unref?.();

export async function cleanupMessageLogs() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("message_logs")
    .delete()
    .lt("sent_at", thirtyDaysAgo);
  if (error) console.error("❌ cleanupMessageLogs error:", error.message);
}

export async function getStats() {
  try {
    const { data, error } = await supabase
      .from("message_logs")
      .select("number, chat_id, is_group, sent_at");
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    console.error("❌ getStats:", err.message);
    return [];
  }
}

// ─── Release Radar Store ──────────────────────────────────────────────────────

const RADAR_JSON_PATH = path.join(process.cwd(), "radar.json");

async function getRadarFallback() {
  try {
    const data = await fs.readFile(RADAR_JSON_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveRadarFallback(data) {
  await fs.writeFile(RADAR_JSON_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function getRadars() {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const { data, error } = await supabase.from("radar_subs").select("*");
      if (error) throw error;
      return data ?? [];
    } catch (err) {
      console.error("❌ Supabase radar_subs error (falling back to JSON):", err.message);
      return getRadarFallback();
    }
  }
  return getRadarFallback();
}

export async function addRadar(id, type, target, chatId, meta = {}) {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const { error } = await supabase
        .from("radar_subs")
        .upsert({ id, type, target, chat_id: chatId, meta, last_seen: "" }, { onConflict: "id" });
      if (!error) return;
    } catch (_err) {
      // ignore, fall through to fallback
    }
  }
  
  const radars = await getRadarFallback();
  const index = radars.findIndex(r => r.id === id);
  const newRadar = { id, type, target, chat_id: chatId, meta, last_seen: "" };
  if (index >= 0) radars[index] = newRadar;
  else radars.push(newRadar);
  await saveRadarFallback(radars);
}

export async function removeRadar(id) {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const { error } = await supabase.from("radar_subs").delete().eq("id", id);
      if (!error) return;
    } catch {}
  }
  
  let radars = await getRadarFallback();
  radars = radars.filter(r => r.id !== id);
  await saveRadarFallback(radars);
}

export async function updateRadarLastSeen(id, lastSeen) {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const { error } = await supabase.from("radar_subs").update({ last_seen: lastSeen }).eq("id", id);
      if (!error) return;
    } catch {}
  }
  
  const radars = await getRadarFallback();
  const index = radars.findIndex(r => r.id === id);
  if (index >= 0) {
    radars[index].last_seen = lastSeen;
    await saveRadarFallback(radars);
  }
}
