import express from "express";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import qrcode from "qrcode";
import { PORT } from "./config.js";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import {
  setSetting,
  addAdmin,
  removeAdmin,
  banNumber,
  unbanNumber,
  addAutoReply,
  removeAutoReply
} from "./db.js";
import {
  refreshSettings,
  refreshAdmins,
  refreshBanned,
  refreshAutoReplies
} from "./cache.js";
import { clearSession } from "./auth/redisSession.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export let lastQR    = null;
export let botStatus = "starting";

// ─── SSE clients ─────────────────────────────────────────────────────────────
const sseClients = new Set();

function pushSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

const logClients = new Set();
export function pushLog(level, msg) {
  const payload = `event: log\ndata: ${JSON.stringify({ time: Date.now(), level, msg })}\n\n`;
  for (const client of logClients) {
    try { client.write(payload); } catch { logClients.delete(client); }
  }
}

// Hook console methods to stream to UI
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = function(...args) { pushLog(30, args.join(" ")); origLog.apply(console, args); }
console.warn = function(...args) { pushLog(40, args.join(" ")); origWarn.apply(console, args); }
console.error = function(...args) { pushLog(50, args.join(" ")); origError.apply(console, args); }

export function setQR(qr)         { lastQR = qr; botStatus = "waiting_qr";   pushSSE("status", { status: "waiting_qr", hasQR: true }); }
export function setConnected()    { lastQR = null; botStatus = "connected";   pushSSE("status", { status: "connected",  hasQR: false }); }
export function setDisconnected() { botStatus = "disconnected";               pushSSE("status", { status: "disconnected", hasQR: false }); }
export function setStarting()     { botStatus = "starting";                   pushSSE("status", { status: "starting",  hasQR: false }); }
export function setConnecting()   { botStatus = "connecting";                 pushSSE("status", { status: "connecting", hasQR: false }); }

export let broadcastCallback = null;
export function setBroadcastCallback(cb) {
  broadcastCallback = cb;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get("/api/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  logClients.add(res);
  req.on("close", () => logClients.delete(res));
});


// ─── Stats API ────────────────────────────────────────────────────────────────

app.get("/api/stats", async (_, res) => {
  try {
    const [logs, admins, banned, autoReplies, settings] = await Promise.all([
      supabase.from("message_logs").select("number, is_group, sent_at"),
      supabase.from("admins").select("number"),
      supabase.from("banned_numbers").select("number, reason"),
      supabase.from("auto_replies").select("keyword, response"),
      supabase.from("settings").select("key, value"),
    ]);

    const data   = logs.data ?? [];
    const total  = data.length;
    const today  = new Date().toISOString().split("T")[0];
    const todayCount = data.filter((l) => l.sent_at?.startsWith(today)).length;
    const groups = data.filter((l) => l.is_group).length;
    const dms    = total - groups;

    const senderMap = {};
    for (const l of data) {
      if (!senderMap[l.number]) senderMap[l.number] = { count: 0, last: l.sent_at };
      senderMap[l.number].count++;
      if (l.sent_at > senderMap[l.number].last) senderMap[l.number].last = l.sent_at;
    }
    const topSenders = Object.entries(senderMap)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([number, v]) => ({ number, count: v.count, last: v.last }));

    const up = Math.floor(process.uptime());
    const h  = String(Math.floor(up / 3600)).padStart(2, "0");
    const m  = String(Math.floor((up % 3600) / 60)).padStart(2, "0");
    const s  = String(up % 60).padStart(2, "0");

    res.json({
      total, today: todayCount, groups, dms,
      adminCount: admins.data?.length ?? 0,
      admins: admins.data ?? [],
      bannedCount: banned.data?.length ?? 0,
      bannedList: banned.data ?? [],
      autoRepliesCount: autoReplies.data?.length ?? 0,
      autoRepliesList: autoReplies.data ?? [],
      uptime: `${h}:${m}:${s}`,
      topSenders,
      settings: settings.data ?? [],
      status: botStatus,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Mutation APIs ─────────────────────────────────────────────────────────────

app.post("/api/settings", async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "Missing key" });
  try {
    await setSetting(key, value);
    await refreshSettings();
    cachedStatsPayload = null; // force fetch refresh
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admins", async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: "Missing number" });
  try {
    await addAdmin(number);
    await refreshAdmins();
    cachedStatsPayload = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admins/:number", async (req, res) => {
  const { number } = req.params;
  try {
    await removeAdmin(number);
    await refreshAdmins();
    cachedStatsPayload = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/banned", async (req, res) => {
  const { number, reason } = req.body;
  if (!number) return res.status(400).json({ error: "Missing number" });
  try {
    await banNumber(number, reason || "Banned via Web Panel");
    await refreshBanned();
    cachedStatsPayload = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/banned/:number", async (req, res) => {
  const { number } = req.params;
  try {
    await unbanNumber(number);
    await refreshBanned();
    cachedStatsPayload = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/autoreplies", async (req, res) => {
  const { keyword, response } = req.body;
  if (!keyword || !response) return res.status(400).json({ error: "Missing keyword or response" });
  try {
    await addAutoReply(keyword, response);
    await refreshAutoReplies();
    cachedStatsPayload = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/autoreplies/:keyword", async (req, res) => {
  const { keyword } = req.params;
  try {
    await removeAutoReply(keyword);
    await refreshAutoReplies();
    cachedStatsPayload = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/reconnect", async (req, res) => {
  try {
    console.log("🔄 Reconnect triggered via Web Control Panel...");
    res.json({ success: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/wipe", async (req, res) => {
  try {
    console.log("🧹 Session wipe triggered via Web Control Panel...");
    await clearSession();
    res.json({ success: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE endpoint ─────────────────────────────────────────────────────────────

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering on Render
  res.flushHeaders();

  sseClients.add(res);

  // Send current status immediately on connect
  res.write(`event: status\ndata: ${JSON.stringify({ status: botStatus, hasQR: botStatus === "waiting_qr" && !!lastQR })}\n\n`);

  // Heartbeat every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: {}\n\n`); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// Push stats to all SSE clients every second (DB queried every 5s, cached in between)
let cachedStatsPayload = null;
let lastStatsFetch = 0;

async function broadcastStats() {
  if (sseClients.size === 0) return;
  try {
    const now = Date.now();
    if (!cachedStatsPayload || now - lastStatsFetch >= 5000) {
      const [logs, admins, banned, autoReplies, settings] = await Promise.all([
        supabase.from("message_logs").select("number, is_group, sent_at"),
        supabase.from("admins").select("number"),
        supabase.from("banned_numbers").select("number, reason"),
        supabase.from("auto_replies").select("keyword, response"),
        supabase.from("settings").select("key, value"),
      ]);
      const data  = logs.data ?? [];
      const total = data.length;
      const today = new Date().toISOString().split("T")[0];
      const todayCount = data.filter(l => l.sent_at?.startsWith(today)).length;
      const groups = data.filter(l => l.is_group).length;
      const senderMap = {};
      for (const l of data) {
        if (!senderMap[l.number]) senderMap[l.number] = { count: 0, last: l.sent_at };
        senderMap[l.number].count++;
        if (l.sent_at > senderMap[l.number].last) senderMap[l.number].last = l.sent_at;
      }
      const topSenders = Object.entries(senderMap)
        .sort((a, b) => b[1].count - a[1].count).slice(0, 5)
        .map(([number, v]) => ({ number, count: v.count, last: v.last }));
      cachedStatsPayload = {
        total, today: todayCount, groups, dms: total - groups,
        adminCount: admins.data?.length ?? 0,
        admins: admins.data ?? [],
        bannedCount: banned.data?.length ?? 0,
        bannedList: banned.data ?? [],
        autoRepliesCount: autoReplies.data?.length ?? 0,
        autoRepliesList: autoReplies.data ?? [],
        topSenders,
        settings: settings.data ?? [],
      };
      lastStatsFetch = now;
    }

    // Always recalculate uptime (cheap, no DB needed)
    const up = Math.floor(process.uptime());
    const h = String(Math.floor(up / 3600)).padStart(2, "0");
    const m = String(Math.floor((up % 3600) / 60)).padStart(2, "0");
    const s = String(up % 60).padStart(2, "0");
    pushSSE("stats", { ...cachedStatsPayload, uptime: `${h}:${m}:${s}` });
  } catch {}
}

setInterval(broadcastStats, 1000);

// ─── QR Image ─────────────────────────────────────────────────────────────────

app.get("/qr-image", async (_, res) => {
  if (!lastQR) return res.status(404).send("No QR available");
  try {
    const img = await qrcode.toBuffer(lastQR);
    res.setHeader("Content-Type", "image/png");
    res.send(img);
  } catch {
    res.status(500).send("Failed to generate QR image");
  }
});

app.get("/health", (_, res) => {
  res.json({ status: botStatus, uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
});

export function startServer() {
  app.listen(PORT, () => console.log(`🌐 Web server on port ${PORT}`));
}
