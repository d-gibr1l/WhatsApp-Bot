import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// ─── Buffered Stats Logging ───────────────────────────────────────────────────

let logBuffer = [];
let isFlushingLogs = false;

export function logMessage(number, chatId, isGroup) {
  logBuffer.push({
    number,
    chat_id:  chatId,
    is_group: isGroup,
    sent_at:  new Date().toISOString(),
  });
}

setInterval(async () => {
  if (logBuffer.length === 0 || isFlushingLogs) return;
  isFlushingLogs = true;
  const batch = [...logBuffer];
  logBuffer = [];
  try {
    const { error } = await supabase.from("message_logs").insert(batch);
    if (error) throw error;
  } catch (err) {
    console.error(`❌ Failed to flush ${batch.length} message logs:`, err.message);
  } finally {
    isFlushingLogs = false;
  }
}, 5000);

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