import express from "express";
import qrcode from "qrcode";
import { PORT } from "./config.js";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

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

export function setQR(qr)         { lastQR = qr; botStatus = "waiting_qr";   pushSSE("status", { status: "waiting_qr", hasQR: true }); }
export function setConnected()    { lastQR = null; botStatus = "connected";   pushSSE("status", { status: "connected",  hasQR: false }); }
export function setDisconnected() { botStatus = "disconnected";               pushSSE("status", { status: "disconnected", hasQR: false }); }
export function setStarting()     { botStatus = "starting";                   pushSSE("status", { status: "starting",  hasQR: false }); }
export function setConnecting()   { botStatus = "connecting";                 pushSSE("status", { status: "connecting", hasQR: false }); }

const app = express();

const HTML = (status, hasQR) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>WA Bot — Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #080c10;
      --surface: #0d1117;
      --border: #1a2030;
      --text: #e6edf3;
      --muted: #4a5568;
      --accent: #25d366;
      --accent-dim: #25d36618;
      --accent-glow: #25d36640;
      --warn: #f59e0b;
      --danger: #ef4444;
      --blue: #3b82f6;
      --font-d: 'Syne', sans-serif;
      --font-m: 'JetBrains Mono', monospace;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-d); background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; }
    body::before {
      content: ''; position: fixed; inset: 0;
      background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 100%);
      pointer-events: none; z-index: 0;
    }
    body::after {
      content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
      width: 600px; height: 400px;
      background: radial-gradient(ellipse, var(--accent-glow) 0%, transparent 70%);
      pointer-events: none; z-index: 0;
    }
    .wrap { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 32px 24px 64px; }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 40px; padding-bottom: 32px; border-bottom: 1px solid var(--border); }
    .logo { display: flex; align-items: center; gap: 14px; }
    .logo-icon { width: 44px; height: 44px; border-radius: 12px; background: var(--accent-dim); border: 1px solid var(--accent-glow); display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 0 20px var(--accent-glow); }
    .logo-text h1 { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.02em; }
    .logo-text p { font-size: 0.72rem; color: var(--muted); font-family: var(--font-m); margin-top: 2px; }
    .status-pill { display: inline-flex; align-items: center; gap: 7px; padding: 6px 14px 6px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; font-family: var(--font-m); }
    .status-pill.connected    { background: #0d2818; color: var(--accent); border: 1px solid #16a34a50; }
    .status-pill.waiting_qr  { background: #2a1f00; color: var(--warn);   border: 1px solid #d9770650; }
    .status-pill.disconnected { background: #1f0d0d; color: var(--danger); border: 1px solid #dc262650; }
    .status-pill.starting, .status-pill.connecting { background: #0d1a2e; color: var(--blue); border: 1px solid #3b82f650; }
    .pulse { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .connected .pulse { background: var(--accent); animation: ping 1.4s ease infinite; }
    .waiting_qr .pulse { background: var(--warn); }
    .disconnected .pulse { background: var(--danger); }
    .starting .pulse, .connecting .pulse { background: var(--blue); }
    @keyframes ping { 0%{box-shadow:0 0 0 0 var(--accent-glow)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent} }
    .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .refresh-btn { background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.78rem; font-family: var(--font-m); transition: all 0.2s; display: flex; align-items: center; gap: 6px; }
    .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }
    .qr-wrap { display: flex; align-items: center; gap: 32px; background: var(--surface); border: 1px solid #25d36620; border-radius: 16px; padding: 28px 32px; margin-bottom: 32px; animation: fadeUp 0.5s ease; }
    .qr-img-frame { flex-shrink: 0; padding: 10px; background: white; border-radius: 12px; box-shadow: 0 0 40px var(--accent-glow); }
    .qr-img-frame img { display: block; width: 180px; height: 180px; border-radius: 6px; }
    .qr-info h2 { font-size: 1.1rem; font-weight: 700; margin-bottom: 8px; color: var(--warn); }
    .qr-info p { font-size: 0.82rem; color: var(--muted); line-height: 1.7; }
    .qr-steps { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
    .qr-step { display: flex; align-items: center; gap: 10px; font-size: 0.78rem; color: #6b7a8d; }
    .qr-step-num { width: 20px; height: 20px; border-radius: 50%; background: var(--border); color: var(--muted); display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 700; font-family: var(--font-m); flex-shrink: 0; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    @media(max-width:768px){.stats-grid{grid-template-columns:repeat(2,1fr)}}
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; overflow: hidden; position: relative; transition: border-color 0.2s; animation: fadeUp 0.4s ease both; }
    .stat-card:hover { border-color: #25d36630; }
    .stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent-dim), transparent); }
    .stat-label { font-size: 0.65rem; font-family: var(--font-m); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; }
    .stat-val { font-size: 2rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
    .stat-sub { font-size: 0.68rem; font-family: var(--font-m); color: var(--muted); margin-top: 6px; }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    @media(max-width:700px){.panels{grid-template-columns:1fr}}
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; animation: fadeUp 0.5s ease both; }
    .panel-head { display: flex; align-items: center; gap: 8px; padding: 14px 20px; border-bottom: 1px solid var(--border); font-size: 0.72rem; font-family: var(--font-m); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .panel-dot { width: 6px; height: 6px; border-radius: 50%; opacity: 0.6; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 0.65rem; font-family: var(--font-m); color: var(--muted); padding: 10px 20px; border-bottom: 1px solid var(--border); font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; }
    td { padding: 10px 20px; font-size: 0.8rem; color: #8892a4; border-bottom: 1px solid #0f151c; font-family: var(--font-m); }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #0d1117; color: var(--text); }
    .rank { display: inline-block; width: 20px; height: 20px; border-radius: 4px; background: var(--border); color: var(--muted); font-size: 0.6rem; font-weight: 700; text-align: center; line-height: 20px; }
    .rank.g { background: #2a2000; color: #f59e0b; }
    .rank.s { background: #1a2030; color: #94a3b8; }
    .rank.b { background: #1a1510; color: #a06040; }
    .bar-wrap { display: flex; align-items: center; gap: 8px; }
    .bar { height: 3px; border-radius: 2px; background: var(--accent); opacity: 0.5; }
    .chip { display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--border); font-size: 0.68rem; color: var(--muted); }
    .on  { color: var(--accent); }
    .off { color: var(--danger); }
    .hidden-val { color: var(--muted); letter-spacing: 0.1em; }
    .skeleton { background: linear-gradient(90deg,var(--surface) 25%,var(--border) 50%,var(--surface) 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 8px; height: 120px; }
    @keyframes shimmer { 0%{background-position:200% 0}100%{background-position:-200% 0} }
    @keyframes fadeUp { from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)} }
    .err { padding: 20px; text-align: center; color: var(--danger); font-family: var(--font-m); font-size: 0.8rem; }
    .empty { text-align: center; color: #2d3748; padding: 20px; }
  </style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">
      <div class="logo-icon">🤖</div>
      <div class="logo-text">
        <h1>WhatsApp Bot</h1>
        <p id="ts">—</p>
      </div>
    </div>
    <div class="header-right">
      <span class="status-pill ${status}" id="status-pill">
        <span class="pulse"></span>
        <span>${
          status === "connected"    ? "Connected"     :
          status === "waiting_qr"  ? "Awaiting Scan" :
          status === "disconnected"? "Disconnected"  :
          status === "connecting"  ? "Connecting"    : "Starting"
        }</span>
      </span>
      <button class="refresh-btn" onclick="location.reload()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        Refresh
      </button>
    </div>
  </div>

  ${hasQR ? `
  <div class="qr-wrap">
    <div class="qr-img-frame"><img src="/qr-image" alt="QR"/></div>
    <div class="qr-info">
      <h2>📱 Scan to connect</h2>
      <p>Open WhatsApp on your phone and<br/>scan this code to link the bot.</p>
      <div class="qr-steps">
        <div class="qr-step"><span class="qr-step-num">1</span>Open WhatsApp and tap the menu</div>
        <div class="qr-step"><span class="qr-step-num">2</span>Tap "Linked Devices"</div>
        <div class="qr-step"><span class="qr-step-num">3</span>Tap "Link a Device" and scan</div>
      </div>
    </div>
  </div>` : ""}

  <div id="content"><div class="skeleton"></div></div>
</div>

<script>
  // ── Clock ──────────────────────────────────────────────────────────────────
  function tickClock() {
    document.getElementById('ts').textContent = new Date().toLocaleString();
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const SENSITIVE = ['rapidapi_key','groq_api_key','yt_cookies','anthropic_api_key','gemini_api_key'];
  const BOOLS     = ['ai_enabled','word_filter','anti_link','anti_delete','dl_enabled'];

  function settingVal(key, val) {
    if (SENSITIVE.includes(key)) return '<span class="hidden-val">••••••••</span>';
    if (BOOLS.includes(key) || val === 'true' || val === 'false')
      return val === 'true' ? '<span class="on">ON</span>' : '<span class="off">OFF</span>';
    return '<span style="color:#94a3b8">' + (val ?? '—') + '</span>';
  }
  function rankClass(i) { return i===0?'g':i===1?'s':i===2?'b':''; }

  // Animate a number counting up
  function animateNum(el, target) {
    const start = parseInt(el.textContent.replace(/,/g, '')) || 0;
    if (start === target) return;
    const dur = 600, steps = 20, inc = (target - start) / steps;
    let step = 0;
    const t = setInterval(() => {
      step++;
      const val = step >= steps ? target : Math.round(start + inc * step);
      el.textContent = val.toLocaleString();
      if (step >= steps) clearInterval(t);
    }, dur / steps);
  }

  // ── Render full content (first load) ──────────────────────────────────────
  function renderContent(d) {
    const max = d.topSenders.length > 0 ? d.topSenders[0].count : 1;
    document.getElementById('content').innerHTML =
      '<div class="stats-grid" id="stats-grid">' + [
        ['Total Messages', d.total,       '',                   'stat-total'],
        ['Today',          d.today,       '',                   'stat-today'],
        ['Groups',         d.groups,      'of ' + d.total + ' msgs', 'stat-groups'],
        ['DMs',            d.dms,         '',                   'stat-dms'],
        ['Admins',         d.adminCount,  '',                   'stat-admins'],
        ['Banned',         d.bannedCount, 'numbers',            'stat-banned'],
        ['Auto Replies',   d.autoReplies, '',                   'stat-autoreplies'],
        ['Uptime',         d.uptime,      'hh:mm:ss',           'stat-uptime'],
      ].map(([label, val, sub, id], i) => {
        const isUptime = id === 'stat-uptime';
        const isBanned = id === 'stat-banned';
        const displayVal = isUptime
          ? '<span style="font-size:1.3rem;color:var(--accent)" id="' + id + '">' + val + '</span>'
          : isBanned
          ? '<span id="' + id + '" style="color:' + (val > 0 ? 'var(--danger)' : 'inherit') + '">' + val.toLocaleString() + '</span>'
          : '<span id="' + id + '">' + (typeof val === 'number' ? val.toLocaleString() : val) + '</span>';
        return '<div class="stat-card" style="animation-delay:' + (i * 0.05) + 's">' +
          '<div class="stat-label">' + label + '</div>' +
          '<div class="stat-val">' + displayVal + '</div>' +
          (sub ? '<div class="stat-sub" id="' + id + '-sub">' + sub + '</div>' : '') +
          '</div>';
      }).join('') + '</div>' +

      '<div class="panels">' +
      '<div class="panel"><div class="panel-head"><span class="panel-dot" style="background:var(--accent)"></span>Top Senders</div>' +
      '<table><tr><th>#</th><th>Number</th><th>Messages</th></tr>' +
      '<tbody id="senders-body">' + renderSenders(d.topSenders, max) + '</tbody></table></div>' +

      '<div class="panel"><div class="panel-head"><span class="panel-dot" style="background:var(--blue)"></span>Settings</div>' +
      '<table><tr><th>Key</th><th>Value</th></tr>' +
      '<tbody id="settings-body">' + renderSettings(d.settings) + '</tbody></table></div>' +
      '</div>' +

      '<div id="live-indicator" style="text-align:right;margin-top:12px;font-size:0.65rem;font-family:var(--font-m);color:var(--muted)">' +
      '<span style="color:var(--accent)">●</span> LIVE — updated <span id="last-update">just now</span></div>';
  }

  function renderSenders(senders, max) {
    if (senders.length === 0) return '<tr><td colspan="3" class="empty">No data yet</td></tr>';
    return senders.map((s, i) =>
      '<tr><td><span class="rank ' + rankClass(i) + '">' + (i+1) + '</span></td>' +
      '<td>+' + s.number + '</td>' +
      '<td><div class="bar-wrap"><span>' + s.count + '</span>' +
      '<div class="bar" style="width:' + Math.round((s.count/max)*80) + 'px"></div></div></td></tr>'
    ).join('');
  }

  function renderSettings(settings) {
    if (settings.length === 0) return '<tr><td colspan="2" class="empty">No settings</td></tr>';
    return settings.map(s =>
      '<tr><td><span class="chip">' + s.key + '</span></td><td>' + settingVal(s.key, s.value) + '</td></tr>'
    ).join('');
  }

  // ── In-place update (after first load) ────────────────────────────────────
  function updateStats(d) {
    const max = d.topSenders.length > 0 ? d.topSenders[0].count : 1;

    const updates = {
      'stat-total':       d.total,
      'stat-today':       d.today,
      'stat-groups':      d.groups,
      'stat-dms':         d.dms,
      'stat-admins':      d.adminCount,
      'stat-autoreplies': d.autoReplies,
    };

    for (const [id, val] of Object.entries(updates)) {
      const el = document.getElementById(id);
      if (el) animateNum(el, val);
    }

    // Groups sub-label
    const groupSub = document.getElementById('stat-groups-sub');
    if (groupSub) groupSub.textContent = 'of ' + d.total + ' msgs';

    // Banned — changes color if >0
    const bannedEl = document.getElementById('stat-banned');
    if (bannedEl) {
      animateNum(bannedEl, d.bannedCount);
      bannedEl.style.color = d.bannedCount > 0 ? 'var(--danger)' : 'inherit';
    }

    // Uptime — just replace text
    const uptimeEl = document.getElementById('stat-uptime');
    if (uptimeEl) uptimeEl.textContent = d.uptime;

    // Tables — re-render bodies
    const sb = document.getElementById('senders-body');
    if (sb) sb.innerHTML = renderSenders(d.topSenders, max);
    const stb = document.getElementById('settings-body');
    if (stb) stb.innerHTML = renderSettings(d.settings);

    // Last updated
    const lu = document.getElementById('last-update');
    if (lu) lu.textContent = new Date().toLocaleTimeString();
  }

  // ── Status pill update ─────────────────────────────────────────────────────
  const STATUS_LABELS = {
    connected: 'Connected', waiting_qr: 'Awaiting Scan',
    disconnected: 'Disconnected', connecting: 'Connecting', starting: 'Starting'
  };
  const PULSE_COLORS = {
    connected: 'var(--accent)', waiting_qr: 'var(--warn)',
    disconnected: 'var(--danger)', connecting: 'var(--blue)', starting: 'var(--blue)'
  };

  function updateStatusPill(status) {
    const pill = document.getElementById('status-pill');
    if (!pill) return;
    pill.className = 'status-pill ' + status;
    const pulse = pill.querySelector('.pulse');
    if (pulse) pulse.style.background = PULSE_COLORS[status] || 'var(--muted)';
    const label = pill.querySelector('span:last-child');
    if (label) label.textContent = STATUS_LABELS[status] || status;
  }

  // ── QR section ────────────────────────────────────────────────────────────
  function showQR() {
    let qrWrap = document.getElementById('qr-section');
    if (!qrWrap) {
      qrWrap = document.createElement('div');
      qrWrap.id = 'qr-section';
      qrWrap.className = 'qr-wrap';
      qrWrap.innerHTML =
        '<div class="qr-img-frame"><img src="/qr-image?t=' + Date.now() + '" alt="QR"/></div>' +
        '<div class="qr-info"><h2>📱 Scan to connect</h2>' +
        '<p>Open WhatsApp on your phone and<br/>scan this code to link the bot.</p>' +
        '<div class="qr-steps">' +
        '<div class="qr-step"><span class="qr-step-num">1</span>Open WhatsApp and tap the menu</div>' +
        '<div class="qr-step"><span class="qr-step-num">2</span>Tap "Linked Devices"</div>' +
        '<div class="qr-step"><span class="qr-step-num">3</span>Tap "Link a Device" and scan</div>' +
        '</div></div>';
      document.getElementById('content').before(qrWrap);
    } else {
      // Refresh QR image
      const img = qrWrap.querySelector('img');
      if (img) img.src = '/qr-image?t=' + Date.now();
    }
  }

  function hideQR() {
    const qrWrap = document.getElementById('qr-section');
    if (qrWrap) qrWrap.remove();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  let loaded = false;

  async function initialLoad() {
    try {
      const d = await fetch('/api/stats').then(r => r.json());
      renderContent(d);
      loaded = true;
    } catch(e) {
      document.getElementById('content').innerHTML = '<div class="err">Failed to load — ' + e.message + '</div>';
    }
  }

  // ── SSE live updates ───────────────────────────────────────────────────────
  function connectSSE() {
    const es = new EventSource('/api/events');

    es.addEventListener('stats', e => {
      if (!loaded) return;
      try { updateStats(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener('status', e => {
      try {
        const { status, hasQR } = JSON.parse(e.data);
        updateStatusPill(status);
        if (hasQR) showQR(); else hideQR();
      } catch {}
    });

    es.addEventListener('heartbeat', () => {
      // Connection alive — optionally show indicator
    });

    es.onerror = () => {
      // SSE disconnected — reconnect after 3s
      es.close();
      setTimeout(connectSSE, 3000);
    };
  }

  initialLoad();
  connectSSE();
</script>
</body>
</html>`;

app.get("/", (_, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(HTML(botStatus, botStatus === "waiting_qr" && lastQR));
});

// ─── Stats API ────────────────────────────────────────────────────────────────

app.get("/api/stats", async (_, res) => {
  try {
    const [logs, admins, banned, autoReplies, settings] = await Promise.all([
      supabase.from("message_logs").select("number, is_group, sent_at"),
      supabase.from("admins").select("number"),
      supabase.from("banned_numbers").select("number"),
      supabase.from("auto_replies").select("keyword"),
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
      bannedCount: banned.data?.length ?? 0,
      autoReplies: autoReplies.data?.length ?? 0,
      uptime: `${h}:${m}:${s}`,
      topSenders,
      settings: settings.data ?? [],
      status: botStatus,
    });
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

// Push stats to all SSE clients every 5 seconds
async function broadcastStats() {
  if (sseClients.size === 0) return;
  try {
    const [logs, admins, banned, autoReplies, settings] = await Promise.all([
      supabase.from("message_logs").select("number, is_group, sent_at"),
      supabase.from("admins").select("number"),
      supabase.from("banned_numbers").select("number"),
      supabase.from("auto_replies").select("keyword"),
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
    const up = Math.floor(process.uptime());
    const h = String(Math.floor(up / 3600)).padStart(2, "0");
    const m = String(Math.floor((up % 3600) / 60)).padStart(2, "0");
    const s = String(up % 60).padStart(2, "0");
    pushSSE("stats", {
      total, today: todayCount, groups, dms: total - groups,
      adminCount: admins.data?.length ?? 0,
      bannedCount: banned.data?.length ?? 0,
      autoReplies: autoReplies.data?.length ?? 0,
      uptime: `${h}:${m}:${s}`,
      topSenders,
      settings: settings.data ?? [],
    });
  } catch {}
}

setInterval(broadcastStats, 5000);

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