import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { config } from "dotenv";

config();

const MONGODB_URI = process.env.MONGODB || process.env.MONGODB_URI || process.env.DATABASE_URL;
export const USE_MONGO = !!(MONGODB_URI && MONGODB_URI.startsWith("mongodb"));

// ==========================================
// 1. Storage Engine Setup
// ==========================================

const DB_FILE = path.join(process.cwd(), "database.json");

let jsonCache = {
  settings: {},
  admins: [],
  banned_numbers: {},
  allowed_groups: {},
  auto_replies: {},
  warnings: {},
  reminders: [],
  antidelete_store: {},
  message_logs: [],
  radar_subs: [],
  users: {},
  groups: {},
  system: { id: "1", seletedCharacter: "0", PMchatBot: false, botMode: "public" },
  plugins: {}
};

let dbReady = false;

async function initDB() {
  if (USE_MONGO) {
    try {
      await mongoose.connect(MONGODB_URI, { family: 4 });
      console.log("[ HOOPER ] Connected to MongoDB.");
      dbReady = true;
    } catch (e) {
      console.error("[ EXCEPTION ] Failed to connect to MongoDB:", e.message);
    }
  } else {
    try {
      const data = await fs.readFile(DB_FILE, "utf-8");
      jsonCache = { ...jsonCache, ...JSON.parse(data) };
    } catch (e) {
      // File doesn't exist yet, we will save on next write
      await saveJSON();
    }
    console.log("[ HOOPER ] Using Local JSON Database.");
    dbReady = true;
  }
}

async function saveJSON() {
  if (USE_MONGO) return;
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(jsonCache, null, 2), "utf-8");
  } catch (e) {
    console.error("[ EXCEPTION ] Failed to write local JSON DB:", e.message);
  }
}

// Call init once
initDB();

// ==========================================
// 2. Mongoose Schemas (if USE_MONGO is true)
// ==========================================
export const Models = {};
if (USE_MONGO) {
  Models.Setting = mongoose.model("Setting", new mongoose.Schema({ key: { type: String, unique: true }, value: String }));
  Models.Admin = mongoose.model("Admin", new mongoose.Schema({ number: { type: String, unique: true } }));
  Models.Banned = mongoose.model("Banned", new mongoose.Schema({ number: { type: String, unique: true }, reason: String }));
  Models.Group = mongoose.model("AllowedGroup", new mongoose.Schema({ group_id: { type: String, unique: true }, name: String }));
  Models.AutoReply = mongoose.model("AutoReply", new mongoose.Schema({ keyword: { type: String, unique: true }, response: String }));
  Models.Warning = mongoose.model("Warning", new mongoose.Schema({ number: { type: String, unique: true }, count: Number, reasons: [String] }));
  Models.Reminder = mongoose.model("Reminder", new mongoose.Schema({ id: String, number: String, chat_id: String, message: String, fire_at: Date, done: Boolean }));
  Models.MessageLog = mongoose.model("MessageLog", new mongoose.Schema({ number: String, chat_id: String, is_group: Boolean, sent_at: Date }));
  Models.Radar = mongoose.model("Radar", new mongoose.Schema({ id: { type: String, unique: true }, type: String, target: String, chat_id: String, meta: Object, last_seen: String }));
  
  // Legacy Core Schemas
  Models.User = mongoose.model("User", new mongoose.Schema({ id: { type: String, unique: true }, ban: { type: Boolean, default: false }, name: String, addedMods: { type: Boolean, default: false } }), "userdatas");
  Models.BotGroup = mongoose.model("BotGroup", new mongoose.Schema({ id: { type: String, unique: true }, name: { type: String, default: "" }, in_group: { type: Boolean, default: true }, msgCount: { type: Number, default: 0 }, antilink: { type: Boolean, default: false }, antidelete: { type: Boolean, default: false }, nsfw: { type: Boolean, default: false }, bangroup: { type: Boolean, default: false }, chatBot: { type: Boolean, default: false }, botSwitch: { type: Boolean, default: true }, switchNSFW: { type: Boolean, default: false }, switchWelcome: { type: Boolean, default: false }, allowed: { type: Boolean, default: false } }), "groupdatas");
  Models.System = mongoose.model("System", new mongoose.Schema({ id: { type: String, default: "1" }, seletedCharacter: { type: String, default: "0" }, PMchatBot: { type: Boolean, default: false }, botMode: { type: String, default: "public" } }), "systemdatas");
  Models.Plugin = mongoose.model("Plugin", new mongoose.Schema({ plugin: String, url: String }), "plugindatas");
  Models.Session = mongoose.model("Session", new mongoose.Schema({ sessionId: { type: String, unique: true }, files: Object, lastSync: Date }));
}

// ==========================================
// 3. Unified API (Dashboard + Core)
// ==========================================

export async function getSetting(key, def = null) {
  if (USE_MONGO) {
    const doc = await Models.Setting.findOne({ key });
    return doc ? doc.value : def;
  }
  return jsonCache.settings[key] ?? def;
}

export async function getAllSettings() {
  if (USE_MONGO) {
    const docs = await Models.Setting.find();
    return docs.map(d => ({ key: d.key, value: d.value }));
  }
  return Object.entries(jsonCache.settings).map(([k, v]) => ({ key: k, value: v }));
}

export async function getAdmins() {
  if (USE_MONGO) {
    const docs = await Models.Admin.find();
    return docs.map(d => d.number);
  }
  return [...jsonCache.admins];
}

export async function addAdmin(number) {
  if (USE_MONGO) {
    await Models.Admin.findOneAndUpdate({ number }, { number }, { upsert: true });
  } else {
    if (!jsonCache.admins.includes(number)) jsonCache.admins.push(number);
    await saveJSON();
  }
}

export async function removeAdmin(number) {
  if (USE_MONGO) {
    await Models.Admin.findOneAndDelete({ number });
  } else {
    jsonCache.admins = jsonCache.admins.filter(a => a !== number);
    await saveJSON();
  }
}

export async function getBannedList() {
  if (USE_MONGO) {
    const docs = await Models.Banned.find();
    return docs.map(d => ({ number: d.number, reason: d.reason }));
  }
  return Object.values(jsonCache.banned_numbers);
}

export async function isBanned(number) {
  if (USE_MONGO) {
    const doc = await Models.Banned.findOne({ number });
    return !!doc;
  }
  return !!jsonCache.banned_numbers[number];
}

export async function banNumber(number, reason = "No reason given") {
  if (USE_MONGO) {
    await Models.Banned.findOneAndUpdate({ number }, { reason }, { upsert: true });
  } else {
    jsonCache.banned_numbers[number] = { number, reason };
    await saveJSON();
  }
}

export async function unbanNumber(number) {
  if (USE_MONGO) {
    await Models.Banned.findOneAndDelete({ number });
  } else {
    delete jsonCache.banned_numbers[number];
    await saveJSON();
  }
}

export async function getAllowedGroups() {
  if (USE_MONGO) {
    const docs = await Models.Group.find();
    return docs.map(d => ({ group_id: d.group_id, name: d.name }));
  }
  return Object.values(jsonCache.allowed_groups);
}

export async function allowGroup(group_id, name = "") {
  if (USE_MONGO) {
    await Models.Group.findOneAndUpdate({ group_id }, { name }, { upsert: true });
  } else {
    jsonCache.allowed_groups[group_id] = { group_id, name };
    await saveJSON();
  }
}

export async function removeGroup(group_id) {
  if (USE_MONGO) {
    await Models.Group.findOneAndDelete({ group_id });
  } else {
    delete jsonCache.allowed_groups[group_id];
    await saveJSON();
  }
}

export async function getAllAutoReplies() {
  if (USE_MONGO) {
    const docs = await Models.AutoReply.find();
    return docs.map(d => ({ keyword: d.keyword, response: d.response }));
  }
  return Object.values(jsonCache.auto_replies);
}

export async function addAutoReply(keyword, response) {
  if (USE_MONGO) {
    await Models.AutoReply.findOneAndUpdate({ keyword }, { response }, { upsert: true });
  } else {
    jsonCache.auto_replies[keyword] = { keyword, response };
    await saveJSON();
  }
}

export async function removeAutoReply(keyword) {
  if (USE_MONGO) {
    await Models.AutoReply.findOneAndDelete({ keyword });
  } else {
    delete jsonCache.auto_replies[keyword];
    await saveJSON();
  }
}

export async function getWarnings(number) {
  if (USE_MONGO) {
    const doc = await Models.Warning.findOne({ number });
    return doc ? { count: doc.count, reasons: doc.reasons } : { count: 0, reasons: [] };
  }
  return jsonCache.warnings[number] || { count: 0, reasons: [] };
}

export async function warnUser(number, reason = "No reason given") {
  let w = await getWarnings(number);
  w.count++;
  w.reasons.push(reason);
  if (USE_MONGO) {
    await Models.Warning.findOneAndUpdate({ number }, { count: w.count, reasons: w.reasons }, { upsert: true });
  } else {
    jsonCache.warnings[number] = w;
    await saveJSON();
  }
  return w.count;
}

export async function clearWarnings(number) {
  if (USE_MONGO) {
    await Models.Warning.findOneAndDelete({ number });
  } else {
    delete jsonCache.warnings[number];
    await saveJSON();
  }
}

export async function getAllGroups() {
  if (USE_MONGO) {
    const docs = await Models.BotGroup.find({ in_group: { $ne: false } }).sort({ msgCount: -1 });
    return docs.map(d => ({
      id: d.id,
      name: d.name || "",
      antilink: d.antilink,
      antidelete: d.antidelete,
      nsfw: d.nsfw,
      bangroup: d.bangroup,
      chatBot: d.chatBot,
      botSwitch: d.botSwitch,
      switchNSFW: d.switchNSFW,
      switchWelcome: d.switchWelcome,
      allowed: d.allowed,
    }));
  }
  return Object.values(jsonCache.bot_groups || jsonCache.groups).filter(g => g.in_group !== false);
}

export async function updateGroupFeature(groupId, feature, value) {
  if (USE_MONGO) {
    await Models.BotGroup.findOneAndUpdate({ id: groupId }, { [feature]: Boolean(value) }, { upsert: true });
  } else {
    if (!jsonCache.bot_groups[groupId]) {
      jsonCache.bot_groups[groupId] = { id: groupId, antilink: false, antidelete: false, nsfw: false, bangroup: false, chatBot: false, botSwitch: true, switchNSFW: false, switchWelcome: false };
    }
    jsonCache.bot_groups[groupId][feature] = Boolean(value);
    await saveJSON();
  }
}

export async function getBannedUsersAndGroups() {
  if (USE_MONGO) {
    const [users, groups] = await Promise.all([
      Models.User.find({ ban: true }),
      Models.BotGroup.find({ bangroup: true })
    ]);
    return {
      users: users.map(u => u.id),
      groups: groups.map(g => g.id)
    };
  }
  const users = Object.values(jsonCache.users).filter(u => u.ban).map(u => u.id);
  const groups = Object.values(jsonCache.bot_groups).filter(g => g.bangroup).map(g => g.id);
  return { users, groups };
}

// Stats Log
export function logMessage(number, chatId, isGroup) {
  const log = { number, chat_id: chatId, is_group: isGroup, sent_at: new Date() };
  if (USE_MONGO) {
    Models.MessageLog.create(log).catch(() => {});
    if (isGroup) {
      Models.BotGroup.findOneAndUpdate({ id: chatId }, { $inc: { msgCount: 1 } }).catch(() => {});
    }
  } else {
    jsonCache.message_logs.push(log);
    if (jsonCache.message_logs.length > 5000) jsonCache.message_logs.shift(); // keep last 5000
    // Don't saveJSON on every message, do it periodically or let it be ephemeral
  }
}

export async function getStats() {
  if (USE_MONGO) {
    return await Models.MessageLog.find().sort({ sent_at: -1 }).limit(1000);
  }
  return jsonCache.message_logs;
}

export async function getMessageCount(number) {
  if (USE_MONGO) {
    return await Models.MessageLog.countDocuments({ number });
  }
  return jsonCache.message_logs.filter(m => m.number === number).length;
}

export async function getLastSeen(number) {
  if (USE_MONGO) {
    const doc = await Models.MessageLog.findOne({ number }).sort({ sent_at: -1 });
    return doc ? doc.sent_at : null;
  }
  const userLogs = jsonCache.message_logs.filter(m => m.number === number);
  if (!userLogs.length) return null;
  return userLogs[userLogs.length - 1].sent_at;
}

export async function clearStats() {
  if (USE_MONGO) {
    await Models.MessageLog.deleteMany({});
  } else {
    jsonCache.message_logs = [];
  }
}

// ------------------------------------------
// Core Bot Functions (Supabase_Core.js replacements)
// ------------------------------------------

// User
export async function checkBan(id) {
  if (USE_MONGO) {
    const doc = await Models.User.findOne({ id });
    return doc ? doc.ban : false;
  }
  return jsonCache.users[id]?.ban || false;
}

export async function banUser(id) {
  if (USE_MONGO) {
    await Models.User.findOneAndUpdate({ id }, { ban: true }, { upsert: true });
  } else {
    if (!jsonCache.users[id]) jsonCache.users[id] = {};
    jsonCache.users[id].ban = true;
    await saveJSON();
  }
}

export async function unbanUser(id) {
  if (USE_MONGO) {
    await Models.User.findOneAndUpdate({ id }, { ban: false }, { upsert: true });
  } else {
    if (!jsonCache.users[id]) jsonCache.users[id] = {};
    jsonCache.users[id].ban = false;
    await saveJSON();
  }
}

export async function checkMod(id) {
  if (USE_MONGO) {
    const doc = await Models.User.findOne({ id });
    return doc ? doc.addedMods : false;
  }
  return jsonCache.users[id]?.addedMods || false;
}

export async function addMod(id) {
  if (USE_MONGO) {
    await Models.User.findOneAndUpdate({ id }, { addedMods: true }, { upsert: true });
  } else {
    if (!jsonCache.users[id]) jsonCache.users[id] = {};
    jsonCache.users[id].addedMods = true;
    await saveJSON();
  }
}

export async function delMod(id) {
  if (USE_MONGO) {
    await Models.User.findOneAndUpdate({ id }, { addedMods: false }, { upsert: true });
  } else {
    if (!jsonCache.users[id]) jsonCache.users[id] = {};
    jsonCache.users[id].addedMods = false;
    await saveJSON();
  }
}

// System
export async function getChar() {
  if (USE_MONGO) {
    const doc = await Models.System.findOne({ id: "1" });
    return doc ? doc.seletedCharacter : "0";
  }
  return jsonCache.system.seletedCharacter || "0";
}

export async function setChar(seletedCharacter) {
  if (USE_MONGO) {
    await Models.System.findOneAndUpdate({ id: "1" }, { seletedCharacter }, { upsert: true });
  } else {
    jsonCache.system.seletedCharacter = seletedCharacter;
    await saveJSON();
  }
}

export async function checkPmChatbot() {
  if (USE_MONGO) {
    const doc = await Models.System.findOne({ id: "1" });
    return doc ? doc.PMchatBot : false;
  }
  return jsonCache.system.PMchatBot || false;
}

export async function activateChatBot() {
  if (USE_MONGO) {
    await Models.System.findOneAndUpdate({ id: "1" }, { PMchatBot: true }, { upsert: true });
  } else {
    jsonCache.system.PMchatBot = true;
    await saveJSON();
  }
}

export async function deactivateChatBot() {
  if (USE_MONGO) {
    await Models.System.findOneAndUpdate({ id: "1" }, { PMchatBot: false }, { upsert: true });
  } else {
    jsonCache.system.PMchatBot = false;
    await saveJSON();
  }
}

export async function getBotMode() {
  if (USE_MONGO) {
    const doc = await Models.System.findOne({ id: "1" });
    return doc ? doc.botMode : "public";
  }
  return jsonCache.system.botMode || "public";
}

export async function setBotMode(botMode) {
  if (USE_MONGO) {
    await Models.System.findOneAndUpdate({ id: "1" }, { botMode }, { upsert: true });
  } else {
    jsonCache.system.botMode = botMode;
    await saveJSON();
  }
}

// Groups
async function getGroup(id) {
  if (USE_MONGO) {
    const doc = await Models.BotGroup.findOne({ id });
    return doc || {};
  }
  return jsonCache.groups[id] || {};
}
async function updateGroup(id, payload) {
  if (USE_MONGO) {
    await Models.BotGroup.findOneAndUpdate({ id }, payload, { upsert: true });
  } else {
    if (!jsonCache.groups[id]) jsonCache.groups[id] = {};
    jsonCache.groups[id] = { ...jsonCache.groups[id], ...payload };
    await saveJSON();
  }
}

export async function updateGroupName(id, name) {
  await updateGroup(id, { name, in_group: true });
}

export async function setGroupStatus(id, inGroup) {
  await updateGroup(id, { in_group: inGroup });
}

export const checkWelcome = async (id) => (await getGroup(id)).switchWelcome || false;
export const setWelcome = async (id) => await updateGroup(id, { switchWelcome: true });
export const delWelcome = async (id) => await updateGroup(id, { switchWelcome: false });

export const checkAntilink = async (id) => (await getGroup(id)).antilink || false;
export const setAntilink = async (id) => await updateGroup(id, { antilink: true });
export const delAntilink = async (id) => await updateGroup(id, { antilink: false });

export const checkAntidelete = async (id) => (await getGroup(id)).antidelete || false;
export const setAntidelete = async (id) => await updateGroup(id, { antidelete: true });
export const delAntidelete = async (id) => await updateGroup(id, { antidelete: false });

export const checkGroupChatbot = async (id) => (await getGroup(id)).chatBot || false;
export const setGroupChatbot = async (id) => await updateGroup(id, { chatBot: true });
export const delGroupChatbot = async (id) => await updateGroup(id, { chatBot: false });

export const checkBanGroup = async (id) => (await getGroup(id)).bangroup || false;
export const banGroup = async (id) => await updateGroup(id, { bangroup: true });
export const unbanGroup = async (id) => await updateGroup(id, { bangroup: false });

export const checkNSFW = async (id) => (await getGroup(id)).nsfw || false;
export const setNSFW = async (id) => await updateGroup(id, { nsfw: true });
export const delNSFW = async (id) => await updateGroup(id, { nsfw: false });

// Plugins
export async function pushPlugin(plugin, url) {
  if (USE_MONGO) {
    await Models.Plugin.findOneAndUpdate({ plugin }, { url }, { upsert: true });
  } else {
    jsonCache.plugins[plugin] = url;
    await saveJSON();
  }
}

export async function isPluginPresent(plugin) {
  if (USE_MONGO) {
    const doc = await Models.Plugin.findOne({ plugin });
    return !!doc;
  }
  return !!jsonCache.plugins[plugin];
}

export async function delPlugin(plugin) {
  if (USE_MONGO) {
    await Models.Plugin.findOneAndDelete({ plugin });
  } else {
    delete jsonCache.plugins[plugin];
    await saveJSON();
  }
}

export async function getPluginURLs() {
  if (USE_MONGO) {
    const docs = await Models.Plugin.find();
    return docs.map(d => d.url);
  }
  return Object.values(jsonCache.plugins);
}

export async function getAllPlugins() {
  if (USE_MONGO) {
    return await Models.Plugin.find();
  }
  return Object.entries(jsonCache.plugins).map(([plugin, url]) => ({ plugin, url }));
}

// ------------------------------------------
// Legacy Plugin Replacements
// ------------------------------------------
if (USE_MONGO) {
  Models.Alias = mongoose.model("Alias", new mongoose.Schema({ alias: { type: String, unique: true }, command: String }));
  Models.AllowedLink = mongoose.model("AllowedLink", new mongoose.Schema({ domain: { type: String, unique: true } }));
  Models.WordFilter = mongoose.model("WordFilter", new mongoose.Schema({ word: String, chat_id: String }));
  Models.AiHistory = mongoose.model("AiHistory", new mongoose.Schema({ chat_id: String, role: String, content: String }));
} else {
  jsonCache.aliases = jsonCache.aliases || {};
  jsonCache.allowed_links = jsonCache.allowed_links || [];
  jsonCache.word_filters = jsonCache.word_filters || [];
  jsonCache.ai_history = jsonCache.ai_history || {};
}

// Aliases
export async function getAliases() {
  if (USE_MONGO) {
    const docs = await Models.Alias.find();
    return docs.map(d => ({ alias: d.alias, command: d.command }));
  }
  return Object.entries(jsonCache.aliases).map(([alias, command]) => ({ alias, command }));
}
export async function getAlias(alias) {
  if (USE_MONGO) {
    const doc = await Models.Alias.findOne({ alias });
    return doc ? doc.command : null;
  }
  return jsonCache.aliases[alias];
}
export async function addAlias(alias, command) {
  if (USE_MONGO) {
    await Models.Alias.findOneAndUpdate({ alias }, { command }, { upsert: true });
  } else {
    jsonCache.aliases[alias] = command;
    await saveJSON();
  }
}
export async function removeAlias(alias) {
  if (USE_MONGO) {
    await Models.Alias.findOneAndDelete({ alias });
  } else {
    delete jsonCache.aliases[alias];
    await saveJSON();
  }
}

// Allowed Links
export async function getAllowedLinks() {
  if (USE_MONGO) {
    const docs = await Models.AllowedLink.find();
    return docs.map(d => d.domain);
  }
  return jsonCache.allowed_links;
}
export async function addAllowedLink(domain) {
  if (USE_MONGO) {
    await Models.AllowedLink.findOneAndUpdate({ domain }, { domain }, { upsert: true });
  } else {
    if (!jsonCache.allowed_links.includes(domain)) {
      jsonCache.allowed_links.push(domain);
      await saveJSON();
    }
  }
}
export async function removeAllowedLink(domain) {
  if (USE_MONGO) {
    await Models.AllowedLink.findOneAndDelete({ domain });
  } else {
    jsonCache.allowed_links = jsonCache.allowed_links.filter(d => d !== domain);
    await saveJSON();
  }
}

// Word Filter
export async function getWordFilters(chatId = null) {
  if (USE_MONGO) {
    const filter = chatId ? { chat_id: chatId } : {};
    return await Models.WordFilter.find(filter);
  }
  return chatId ? jsonCache.word_filters.filter(w => w.chat_id === chatId) : jsonCache.word_filters;
}
export async function addWordFilter(word, chatId) {
  if (USE_MONGO) {
    await Models.WordFilter.create({ word, chat_id: chatId });
  } else {
    jsonCache.word_filters.push({ word, chat_id: chatId });
    await saveJSON();
  }
}
export async function removeWordFilter(word, chatId) {
  if (USE_MONGO) {
    await Models.WordFilter.deleteMany({ word, chat_id: chatId });
  } else {
    jsonCache.word_filters = jsonCache.word_filters.filter(w => !(w.word === word && w.chat_id === chatId));
    await saveJSON();
  }
}

// AI History
export async function getAiHistory(chatId) {
  if (USE_MONGO) {
    return await Models.AiHistory.find({ chat_id: chatId }).limit(10);
  }
  return jsonCache.ai_history[chatId] || [];
}
export async function addAiHistory(chatId, role, content) {
  if (USE_MONGO) {
    await Models.AiHistory.create({ chat_id: chatId, role, content });
  } else {
    if (!jsonCache.ai_history[chatId]) jsonCache.ai_history[chatId] = [];
    jsonCache.ai_history[chatId].push({ chat_id: chatId, role, content });
    if (jsonCache.ai_history[chatId].length > 20) jsonCache.ai_history[chatId].shift();
    await saveJSON();
  }
}
export async function clearAiHistory(chatId) {
  if (USE_MONGO) {
    await Models.AiHistory.deleteMany({ chat_id: chatId });
  } else {
    delete jsonCache.ai_history[chatId];
    await saveJSON();
  }
}
export async function setSetting(key, value) {
  if (USE_MONGO) {
    await Models.Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
  } else {
    jsonCache.settings[key] = value;
    await saveJSON();
  }
}
export async function addReminder() { return true; }
export async function getRadars() { return []; }
export async function addRadar() { return true; }
export async function removeRadar() { return true; }
export async function updateRadarLastSeen() { return true; }
export async function storeAntiDeletePayload() { return true; }
export async function getAntiDeletePayload() { return null; }
