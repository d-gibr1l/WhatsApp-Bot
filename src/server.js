import express from "express";
import qrcode from "qrcode";
import { PORT } from "./config.js";
import {
  setSetting,
  addAdmin,
  removeAdmin,
  banNumber,
  unbanNumber,
  addAutoReply,
  removeAutoReply,
  cleanupAntiDeleteStore,
  supabase
} from "./db.js";
import {
  refreshSettings,
  refreshAdmins,
  refreshBanned,
  refreshAutoReplies
} from "./cache.js";
import { clearSession } from "./auth/redisSession.js";

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
app.use(express.json());

const HTML = (status, hasQR) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>WA Bot — Control Panel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070b13;
      --surface: #0f172a80;
      --border: #1e293b;
      --border-glow: #3b82f630;
      --text: #f1f5f9;
      --muted: #64748b;
      --accent: #25d366;
      --accent-dim: #25d36615;
      --accent-glow: #25d36630;
      --warn: #f59e0b;
      --warn-dim: #f59e0b15;
      --danger: #ef4444;
      --danger-dim: #ef444415;
      --blue: #3b82f6;
      --blue-dim: #3b82f615;
      --font-d: 'Syne', sans-serif;
      --font-body: 'Inter', sans-serif;
      --font-m: 'JetBrains Mono', monospace;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-body); background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; }
    
    /* Grid background */
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

    .wrap { position: relative; z-index: 1; max-width: 1200px; margin: 0 auto; padding: 32px 24px 64px; }
    
    /* Header */
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
    .logo { display: flex; align-items: center; gap: 14px; }
    .logo-icon { width: 48px; height: 48px; border-radius: 14px; background: var(--accent-dim); border: 1px solid var(--accent-glow); display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 0 20px var(--accent-glow); }
    .logo-text h1 { font-family: var(--font-d); font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
    .logo-text p { font-size: 0.75rem; color: var(--muted); font-family: var(--font-m); margin-top: 2px; }
    
    .status-pill { display: inline-flex; align-items: center; gap: 7px; padding: 6px 14px 6px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; font-family: var(--font-m); text-transform: uppercase; }
    .status-pill.connected    { background: #062f17; color: var(--accent); border: 1px solid #10b98150; }
    .status-pill.waiting_qr  { background: #3b2300; color: var(--warn);   border: 1px solid #f59e0b50; }
    .status-pill.disconnected { background: #3b0000; color: var(--danger); border: 1px solid #ef444450; }
    .status-pill.starting, .status-pill.connecting { background: #061f3f; color: var(--blue); border: 1px solid #3b82f650; }
    .pulse { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .connected .pulse { background: var(--accent); animation: ping 1.4s ease infinite; }
    .waiting_qr .pulse { background: var(--warn); }
    .disconnected .pulse { background: var(--danger); }
    .starting .pulse, .connecting .pulse { background: var(--blue); }
    @keyframes ping { 0%{box-shadow:0 0 0 0 var(--accent-glow)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent} }
    
    .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .refresh-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 8px 16px; border-radius: 10px; cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: all 0.2s; display: flex; align-items: center; gap: 8px; }
    .refresh-btn:hover { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
    
    /* Navigation Tabs */
    .tabs-nav { display: flex; gap: 8px; margin-bottom: 28px; background: #0b111a80; padding: 6px; border-radius: 12px; border: 1px solid var(--border); width: fit-content; }
    .tab-btn { background: transparent; border: none; color: var(--muted); padding: 10px 18px; border-radius: 8px; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; }
    .tab-btn:hover { color: var(--text); background: #131d2c80; }
    .tab-btn.active { color: var(--text); background: var(--surface); border: 1px solid var(--border); }

    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeUp 0.3s ease-out; }

    /* QR Code Wrap */
    .qr-wrap { display: flex; align-items: center; gap: 32px; background: var(--surface); border: 1px solid #25d36630; border-radius: 16px; padding: 28px 32px; margin-bottom: 32px; animation: fadeUp 0.5s ease; }
    @media(max-width: 600px) { .qr-wrap { flex-direction: column; align-items: center; text-align: center; } }
    .qr-img-frame { flex-shrink: 0; padding: 12px; background: white; border-radius: 14px; box-shadow: 0 0 30px var(--accent-glow); }
    .qr-img-frame img { display: block; width: 180px; height: 180px; border-radius: 8px; }
    .qr-info h2 { font-family: var(--font-d); font-size: 1.25rem; font-weight: 700; margin-bottom: 8px; color: var(--warn); }
    .qr-info p { font-size: 0.88rem; color: var(--muted); line-height: 1.6; }
    .qr-steps { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
    .qr-step { display: flex; align-items: center; gap: 12px; font-size: 0.82rem; color: var(--text); text-align: left; }
    .qr-step-num { width: 22px; height: 22px; border-radius: 50%; background: var(--border); color: var(--muted); display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; font-family: var(--font-m); flex-shrink: 0; }
    
    /* Stats Grid */
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; }
    @media(max-width:900px){.stats-grid{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:550px){.stats-grid{grid-template-columns:1fr}}
    
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px; overflow: hidden; position: relative; transition: all 0.2s; }
    .stat-card:hover { border-color: var(--border-glow); transform: translateY(-2px); }
    .stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--border-glow), transparent); }
    .stat-label { font-size: 0.72rem; font-family: var(--font-m); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; }
    .stat-val { font-size: 2.2rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; font-family: var(--font-m); }
    .stat-sub { font-size: 0.75rem; color: var(--muted); margin-top: 8px; }

    /* Panels & Tables */
    .panels { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 20px; margin-bottom: 20px; }
    @media(max-width:900px){.panels{grid-template-columns:1fr}}
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; height: fit-content; margin-bottom: 20px; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .panel-title { display: flex; align-items: center; gap: 10px; font-family: var(--font-d); font-size: 0.95rem; font-weight: 700; color: var(--text); }
    .panel-dot { width: 8px; height: 8px; border-radius: 50%; }
    
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 0.72rem; font-family: var(--font-m); color: var(--muted); padding: 12px 20px; border-bottom: 1px solid var(--border); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    td { padding: 14px 20px; font-size: 0.88rem; color: var(--text); border-bottom: 1px solid #141d2b; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #131b2980; }
    
    .rank { display: inline-block; width: 22px; height: 22px; border-radius: 6px; background: var(--border); color: var(--muted); font-size: 0.7rem; font-weight: 700; text-align: center; line-height: 22px; font-family: var(--font-m); }
    .rank.g { background: #3b2300; color: #f59e0b; }
    .rank.s { background: #1c2738; color: #94a3b8; }
    .rank.b { background: #261610; color: #d97706; }
    .bar-wrap { display: flex; align-items: center; gap: 12px; }
    .bar { height: 4px; border-radius: 2px; background: var(--accent); opacity: 0.6; box-shadow: 0 0 8px var(--accent-glow); }
    
    /* Settings Grid */
    .settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .setting-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; transition: border-color 0.2s; }
    .setting-card:hover { border-color: var(--border-glow); }
    .setting-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .setting-info h3 { font-family: var(--font-d); font-size: 0.95rem; font-weight: 700; margin-bottom: 4px; }
    .setting-info p { font-size: 0.78rem; color: var(--muted); line-height: 1.4; }
    
    /* Toggle Switch */
    .switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background-color: var(--border); transition: .3s; border-radius: 24px; }
    .slider::before { position: absolute; content: ""; height: 16px; width: 16px; left: 4px; bottom: 4px; background-color: white; transition: .3s; border-radius: 50%; }
    input:checked + .slider { background-color: var(--accent); }
    input:checked + .slider::before { transform: translateX(20px); }
    
    /* Forms & Inputs */
    .input-group { display: flex; gap: 8px; width: 100%; }
    .form-input { flex-grow: 1; background: #0b111a; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px 12px; font-size: 0.85rem; font-family: var(--font-m); outline: none; transition: border-color 0.2s; }
    .form-input:focus { border-color: var(--blue); }
    .input-btn { background: var(--blue); border: none; color: white; padding: 8px 16px; border-radius: 8px; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .input-btn:hover { background: #2563eb; }
    .input-btn.danger { background: var(--danger); }
    .input-btn.danger:hover { background: #dc2626; }
    
    /* System Actions Panel */
    .system-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
    @media(max-width: 600px){.system-panel{grid-template-columns:1fr}}
    .sys-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
    .sys-card h3 { font-family: var(--font-d); font-size: 1.05rem; font-weight: 700; color: var(--text); }
    .sys-card p { font-size: 0.82rem; color: var(--muted); line-height: 1.5; }
    
    /* Lists and Management */
    .action-row { padding: 16px 20px; border-bottom: 1px solid var(--border); background: #131a2640; display: flex; gap: 12px; justify-content: flex-end; }
    .del-btn { background: transparent; border: none; color: var(--danger); font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
    .del-btn:hover { opacity: 0.8; }
    
    /* Toast Alert */
    .toast { background: #111827; border: 1px solid var(--border); border-radius: 10px; padding: 12px 20px; font-size: 0.85rem; font-weight: 500; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); display: flex; align-items: center; gap: 8px; min-width: 250px; animation: slideIn 0.3s ease, fadeOut 0.3s 3.7s ease forwards; transition: all 0.3s; }
    .toast.success { border-color: var(--accent); color: var(--accent); background: #062f17; }
    .toast.error { border-color: var(--danger); color: var(--danger); background: #3b0000; }
    @keyframes slideIn { from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)} }
    @keyframes fadeOut { to{opacity:0;transform:translateY(8px)} }

    .skeleton { background: linear-gradient(90deg,var(--surface) 25%,var(--border) 50%,var(--surface) 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 14px; height: 160px; }
    @keyframes shimmer { 0%{background-position:200% 0}100%{background-position:-200% 0} }
    @keyframes fadeUp { from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)} }
    .err { padding: 32px; text-align: center; color: var(--danger); font-family: var(--font-m); font-size: 0.9rem; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; }
    .empty { text-align: center; color: var(--muted); padding: 30px; font-style: italic; }
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

  <div class="tabs-nav">
    <button class="tab-btn active" id="btn-overview" onclick="switchTab('overview')">📈 Overview</button>
    <button class="tab-btn" id="btn-settings" onclick="switchTab('settings')">⚙️ Settings</button>
    <button class="tab-btn" id="btn-autoreplies" onclick="switchTab('autoreplies')">💬 Auto Replies</button>
    <button class="tab-btn" id="btn-lists" onclick="switchTab('lists')">👥 Admins & Bans</button>
  </div>

  ${hasQR ? `
  <div class="qr-wrap" id="qr-section">
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

  <!-- Overview Tab -->
  <div id="tab-overview" class="tab-content active">
    <div id="overview-loading"><div class="skeleton"></div></div>
  </div>

  <!-- Settings Tab -->
  <div id="tab-settings" class="tab-content">
    <div class="settings-grid">
      <!-- Bot Active -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>Bot Active</h3>
            <p>Master toggle to enable or disable the bot entirely.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-bot_active" onchange="toggleSetting('bot_active')"/>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- AI Active -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>AI Active</h3>
            <p>Enables or disables Gemini/Groq AI responses.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-ai_active" onchange="toggleSetting('ai_active')"/>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- Reject Calls -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>Auto Reject Calls</h3>
            <p>Automatically reject all incoming calls on WhatsApp.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-reject_calls" onchange="toggleSetting('reject_calls')"/>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- Downloader Active -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>Media Downloader</h3>
            <p>Allow downloading of media (YouTube, Tiktok, Facebook, etc.).</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-downloader_active" onchange="toggleSetting('downloader_active')"/>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- Anti Delete Active -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>Anti-Delete</h3>
            <p>Logs and forwards messages deleted by users.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-antidelete_active" onchange="toggleSetting('antidelete_active')"/>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- Anti Link Active -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>Anti-Link</h3>
            <p>Automatically delete links and warn group participants.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-antilink_active" onchange="toggleSetting('antilink_active')"/>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- Word Filter Active -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-info">
            <h3>Word Filter</h3>
            <p>Delete messages containing banned words.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-word_filter_active" onchange="toggleSetting('word_filter_active')"/>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- Max Warnings -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>Max Warnings</h3>
          <p>Maximum warning points allowed before banning/kicking.</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="number" id="setting-max_warnings" class="form-input" placeholder="3"/>
          <button class="input-btn" onclick="updateSettingText('max_warnings')">Save</button>
        </div>
      </div>

      <!-- Sticker Pack Name -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>Sticker Pack Name</h3>
          <p>The sticker pack title displayed on WhatsApp.</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="text" id="setting-sticker_pack_name" class="form-input" placeholder="Bot Stickers"/>
          <button class="input-btn" onclick="updateSettingText('sticker_pack_name')">Save</button>
        </div>
      </div>

      <!-- Sticker Pack Author -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>Sticker Pack Author</h3>
          <p>The publisher name of stickers generated by the bot.</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="text" id="setting-sticker_pack_author" class="form-input" placeholder="WhatsApp Bot"/>
          <button class="input-btn" onclick="updateSettingText('sticker_pack_author')">Save</button>
        </div>
      </div>

      <!-- Gemini API Key -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>Gemini API Key</h3>
          <p>Used for the Google Gemini vision and text LLM features.</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="password" id="setting-gemini_api_key" class="form-input" placeholder="Paste Gemini Key here"/>
          <button class="input-btn" onclick="updateSettingText('gemini_api_key')">Save</button>
        </div>
      </div>

      <!-- Groq API Key -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>Groq API Key</h3>
          <p>Used for high-speed Llama-3 AI response generation.</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="password" id="setting-groq_api_key" class="form-input" placeholder="Paste Groq Key here"/>
          <button class="input-btn" onclick="updateSettingText('groq_api_key')">Save</button>
        </div>
      </div>

      <!-- Tavily API Key -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>Tavily Search API Key</h3>
          <p>Used by the AI search command to search the web.</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="password" id="setting-tavily_api_key" class="form-input" placeholder="Paste Tavily Key here"/>
          <button class="input-btn" onclick="updateSettingText('tavily_api_key')">Save</button>
        </div>
      </div>

      <!-- RapidAPI Key -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>RapidAPI Key</h3>
          <p>Used for media downloads (Instagram, YouTube, etc.).</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="password" id="setting-rapidapi_key" class="form-input" placeholder="Paste RapidAPI Key here"/>
          <button class="input-btn" onclick="updateSettingText('rapidapi_key')">Save</button>
        </div>
      </div>

      <!-- TMDB API Key -->
      <div class="setting-card">
        <div class="setting-info">
          <h3>TMDB API Key</h3>
          <p>Used for the IMDb movie search command.</p>
        </div>
        <div class="input-group" style="margin-top:12px;">
          <input type="password" id="setting-tmdb_api_key" class="form-input" placeholder="Paste TMDB API Key here"/>
          <button class="input-btn" onclick="updateSettingText('tmdb_api_key')">Save</button>
        </div>
      </div>

      <!-- YouTube Cookies -->
      <div class="setting-card" style="grid-column: 1 / -1;">
        <div class="setting-info">
          <h3>YouTube Cookies (Netscape Format)</h3>
          <p>Provide Netscape HTTP cookies to bypass YouTube's data center blocks (e.g., "Sign in to confirm you are not a bot" or "HTTP Error 403: Forbidden").</p>
        </div>
        <div style="margin-top:12px; display:flex; flex-direction:column; gap:8px; width:100%;">
          <textarea id="setting-yt_cookies" class="form-input" rows="6" placeholder="# Netscape HTTP Cookie File..." style="width:100%; font-family:var(--font-m); font-size:0.78rem; resize:vertical;"></textarea>
          <button class="input-btn" onclick="updateSettingText('yt_cookies')">Save Cookies</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Auto Replies Tab -->
  <div id="tab-autoreplies" class="tab-content">
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">
          <span class="panel-dot" style="background:var(--accent)"></span>
          Auto Replies Manager
        </div>
      </div>
      <div class="action-row">
        <div class="input-group" style="max-width: 600px;">
          <input type="text" id="ar-keyword" class="form-input" placeholder="Keyword (e.g. ping)" style="max-width: 180px;"/>
          <input type="text" id="ar-response" class="form-input" placeholder="Response text..."/>
          <button class="input-btn" onclick="addAR()">Add Reply</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Keyword</th>
            <th>Response</th>
            <th style="text-align:right; padding-right:24px;">Action</th>
          </tr>
        </thead>
        <tbody id="ar-body">
          <tr><td colspan="3" class="empty">Loading auto replies...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Admins & Bans Tab -->
  <div id="tab-lists" class="tab-content">
    <div class="panels">
      <!-- Admins Panel -->
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">
            <span class="panel-dot" style="background:var(--accent)"></span>
            Bot Admins
          </div>
        </div>
        <div class="action-row">
          <div class="input-group">
            <input type="text" id="admin-number" class="form-input" placeholder="Phone (e.g. 2335...)"/>
            <button class="input-btn" onclick="addAdminNum()">Add</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Phone Number</th>
              <th style="text-align:right; padding-right:24px;">Action</th>
            </tr>
          </thead>
          <tbody id="admins-body">
            <tr><td colspan="2" class="empty">Loading admins...</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Banned Panel -->
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">
            <span class="panel-dot" style="background:var(--danger)"></span>
            Banned Numbers
          </div>
        </div>
        <div class="action-row">
          <div class="input-group">
            <input type="text" id="ban-number" class="form-input" placeholder="Phone" style="max-width:140px;"/>
            <input type="text" id="ban-reason" class="form-input" placeholder="Reason"/>
            <button class="input-btn danger" onclick="addBanNum()">Ban</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Phone Number</th>
              <th>Reason</th>
              <th style="text-align:right; padding-right:24px;">Action</th>
            </tr>
          </thead>
          <tbody id="banned-body">
            <tr><td colspan="3" class="empty">Loading bans...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<div id="toast-container" style="position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;"></div>

<script>
  // ── Clock ──────────────────────────────────────────────────────────────────
  function tickClock() {
    document.getElementById('ts').textContent = new Date().toLocaleString();
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ── Tab Switching ──────────────────────────────────────────────────────────
  function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    
    document.getElementById('tab-' + tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
  }

  // ── Toast Alerts ───────────────────────────────────────────────────────────
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = (type === 'success' ? '✅ ' : '❌ ') + message;
    container.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ── Animate a number counting up ───────────────────────────────────────────
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

  // ── Populate Settings inputs ───────────────────────────────────────────────
  const BOOLEANS = ['bot_active', 'ai_active', 'reject_calls', 'downloader_active', 'antidelete_active', 'antilink_active', 'word_filter_active'];
  function populateSettingsForm(settings) {
    const map = new Map(settings.map(s => [s.key, s.value]));
    
    // Process booleans
    BOOLEANS.forEach(key => {
      const el = document.getElementById('setting-' + key);
      if (el) {
        el.checked = map.get(key) === 'true';
      }
    });

    // Process other text inputs
    ['max_warnings', 'sticker_pack_name', 'sticker_pack_author', 'gemini_api_key', 'groq_api_key', 'tavily_api_key', 'rapidapi_key', 'tmdb_api_key', 'yt_cookies'].forEach(key => {
      const el = document.getElementById('setting-' + key);
      if (el && map.has(key)) {
        el.value = map.get(key);
      }
    });
  }

  // ── Save Settings ──────────────────────────────────────────────────────────
  async function saveSetting(key, value) {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      }).then(r => r.json());
      if (res.success) {
        showToast('Setting "' + key + '" updated successfully!', 'success');
      } else {
        showToast('Failed to update: ' + res.error, 'error');
      }
    } catch(e) {
      showToast('Network error: ' + e.message, 'error');
    }
  }

  function toggleSetting(key) {
    const el = document.getElementById('setting-' + key);
    saveSetting(key, el.checked ? 'true' : 'false');
  }

  function updateSettingText(key) {
    const el = document.getElementById('setting-' + key);
    saveSetting(key, el.value.trim());
  }

  // ── Manage Auto Replies ────────────────────────────────────────────────────
  async function addAR() {
    const keyword = document.getElementById('ar-keyword').value.trim();
    const response = document.getElementById('ar-response').value.trim();
    if (!keyword || !response) return showToast('Please enter keyword and response', 'error');

    try {
      const res = await fetch('/api/autoreplies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, response })
      }).then(r => r.json());
      if (res.success) {
        showToast('Auto reply added!', 'success');
        document.getElementById('ar-keyword').value = '';
        document.getElementById('ar-response').value = '';
        loadStatsQuietly();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteAR(keyword) {
    if (!confirm('Are you sure you want to delete auto-reply for "' + keyword + '"?')) return;
    try {
      const res = await fetch('/api/autoreplies/' + encodeURIComponent(keyword), {
        method: 'DELETE'
      }).then(r => r.json());
      if (res.success) {
        showToast('Auto reply deleted!', 'success');
        loadStatsQuietly();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  function renderAutoReplies(replies) {
    const tbody = document.getElementById('ar-body');
    if (replies.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty">No auto replies registered</td></tr>';
      return;
    }
    tbody.innerHTML = replies.map(r => 
      '<tr><td><span class="chip">' + r.keyword + '</span></td>' +
      '<td>' + r.response + '</td>' +
      '<td style="text-align:right; padding-right:24px;"><button class="del-btn" onclick="deleteAR(\\'' + r.keyword.replace(/'/g, "\\\\'") + '\\\')">Delete</button></td></tr>'
    ).join('');
  }

  // ── Manage Admins ──────────────────────────────────────────────────────────
  async function addAdminNum() {
    const number = document.getElementById('admin-number').value.trim();
    if (!number) return showToast('Please enter phone number', 'error');
    try {
      const res = await fetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number })
      }).then(r => r.json());
      if (res.success) {
        showToast('Admin added!', 'success');
        document.getElementById('admin-number').value = '';
        loadStatsQuietly();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteAdmin(number) {
    if (!confirm('Remove admin status for ' + number + '?')) return;
    try {
      const res = await fetch('/api/admins/' + encodeURIComponent(number), {
        method: 'DELETE'
      }).then(r => r.json());
      if (res.success) {
        showToast('Admin removed!', 'success');
        loadStatsQuietly();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  function renderAdmins(admins) {
    const tbody = document.getElementById('admins-body');
    if (admins.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty">No admins found</td></tr>';
      return;
    }
    tbody.innerHTML = admins.map(num => 
      '<tr><td>+' + num + '</td>' +
      '<td style="text-align:right; padding-right:24px;"><button class="del-btn" onclick="deleteAdmin(\\'' + num + '\\\')">Remove</button></td></tr>'
    ).join('');
  }

  // ── Manage Bans ─────────────────────────────────────────────────────────────
  async function addBanNum() {
    const number = document.getElementById('ban-number').value.trim();
    const reason = document.getElementById('ban-reason').value.trim();
    if (!number) return showToast('Please enter phone number', 'error');
    try {
      const res = await fetch('/api/banned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, reason })
      }).then(r => r.json());
      if (res.success) {
        showToast('Number banned!', 'success');
        document.getElementById('ban-number').value = '';
        document.getElementById('ban-reason').value = '';
        loadStatsQuietly();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteBan(number) {
    if (!confirm('Unban number ' + number + '?')) return;
    try {
      const res = await fetch('/api/banned/' + encodeURIComponent(number), {
        method: 'DELETE'
      }).then(r => r.json());
      if (res.success) {
        showToast('Number unbanned!', 'success');
        loadStatsQuietly();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  function renderBans(bannedList) {
    const tbody = document.getElementById('banned-body');
    if (bannedList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty">No banned numbers</td></tr>';
      return;
    }
    tbody.innerHTML = bannedList.map(b => 
      '<tr><td>+' + b.number + '</td>' +
      '<td>' + b.reason + '</td>' +
      '<td style="text-align:right; padding-right:24px;"><button class="del-btn" onclick="deleteBan(\\'' + b.number + '\\\')">Unban</button></td></tr>'
    ).join('');
  }

  // ── System Reboot / Wipe Actions ───────────────────────────────────────────
  async function reconnectBot() {
    if (!confirm('Are you sure you want to reboot the bot and reconnect? This will take about 15-30 seconds.')) return;
    try {
      showToast('Triggering bot reconnect reboot...', 'success');
      const res = await fetch('/api/system/reconnect', { method: 'POST' }).then(r => r.json());
      if (res.success) {
        showToast('Reboot signal sent! The page will auto-reload when online.', 'success');
        pollReboot();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  async function wipeSession() {
    const check1 = confirm('⚠️ WARNING: This will completely delete the bot authentication session and log it out of WhatsApp. You will have to scan a new QR code. Continue?');
    if (!check1) return;
    const check2 = prompt('Please type "WIPE" to confirm session deletion:');
    if (check2 !== 'WIPE') return showToast('Session wipe aborted', 'error');

    try {
      showToast('Wiping session and restarting...', 'success');
      const res = await fetch('/api/system/wipe', { method: 'POST' }).then(r => r.json());
      if (res.success) {
        showToast('Session wiped successfully. Awaiting new QR code...', 'success');
        pollReboot();
      } else {
        showToast(res.error, 'error');
      }
    } catch(e) {
      showToast(e.message, 'error');
    }
  }

  function pollReboot() {
    document.getElementById('status-pill').className = 'status-pill starting';
    document.getElementById('status-pill').querySelector('span:last-child').textContent = 'Rebooting...';
    
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/health').then(r => r.json());
        if (res.status) {
          clearInterval(interval);
          showToast('Bot is back online!', 'success');
          setTimeout(() => location.reload(), 1000);
        }
      } catch(e) {
        // Keep polling
      }
    }, 2000);
  }

  // ── Render Overview Tab ────────────────────────────────────────────────────
  function renderOverview(d) {
    const max = d.topSenders.length > 0 ? d.topSenders[0].count : 1;
    document.getElementById('tab-overview').innerHTML =
      '<div class="stats-grid">' + [
        ['Total Messages', d.total,       '',                   'stat-total'],
        ['Today',          d.today,       '',                   'stat-today'],
        ['Groups',         d.groups,      'of ' + d.total + ' msgs', 'stat-groups'],
        ['DMs',            d.dms,         '',                   'stat-dms'],
        ['Admins',         d.adminCount,  '',                   'stat-admins'],
        ['Banned',         d.bannedCount, 'numbers',            'stat-banned'],
        ['Auto Replies',   d.autoRepliesCount, '',              'stat-autoreplies'],
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
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="panel-dot" style="background:var(--accent)"></span>Top Senders</div></div>' +
      '<table><thead><tr><th>#</th><th>Number</th><th>Messages</th></tr></thead>' +
      '<tbody id="senders-body">' + renderSenders(d.topSenders, max) + '</tbody></table></div>' +

      '<div class="panel">' +
      '<div class="panel-head"><div class="panel-title"><span class="panel-dot" style="background:var(--blue)"></span>System Actions</div></div>' +
      '<div style="padding: 20px; display:flex; flex-direction:column; gap:20px;">' +
      '<div style="display:flex; flex-direction:column; gap:6px;">' +
      '<h4 style="font-size:0.9rem; font-weight:700;">🔄 Soft Reconnect</h4>' +
      '<p style="font-size:0.78rem; color:var(--muted); line-height:1.4;">Gracefully restart the WhatsApp socket connection and reboot the bot process.</p>' +
      '<button class="input-btn" style="width:fit-content; margin-top:6px;" onclick="reconnectBot()">Reconnect Bot</button>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border); padding-top:20px; display:flex; flex-direction:column; gap:6px;">' +
      '<h4 style="font-size:0.9rem; font-weight:700; color:var(--danger)">⚠️ Hard Session Wipe</h4>' +
      '<p style="font-size:0.78rem; color:var(--muted); line-height:1.4;">Delete all credentials in MongoDB and log the bot out of WhatsApp completely to scan a new QR code.</p>' +
      '<button class="input-btn danger" style="width:fit-content; margin-top:6px;" onclick="wipeSession()">Wipe & Generate QR</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +

      '<div id="live-indicator" style="text-align:right;margin-top:12px;font-size:0.65rem;font-family:var(--font-m);color:var(--muted)">' +
      '<span style="color:var(--accent)">●</span> LIVE — updated <span id="last-update">just now</span></div>';
  }

  function renderSenders(senders, max) {
    if (senders.length === 0) return '<tr><td colspan="3" class="empty">No message logs yet</td></tr>';
    return senders.map((s, i) => {
      const rankClass = i===0?'g':i===1?'s':i===2?'b':'';
      return '<tr><td><span class="rank ' + rankClass + '">' + (i+1) + '</span></td>' +
      '<td>+' + s.number + '</td>' +
      '<td><div class="bar-wrap"><span>' + s.count + '</span>' +
      '<div class="bar" style="width:' + Math.round((s.count/max)*100) + 'px"></div></div></td></tr>';
    }).join('');
  }

  // ── Live Updates (SSE) ─────────────────────────────────────────────────────
  function updateLiveOverview(d) {
    const max = d.topSenders.length > 0 ? d.topSenders[0].count : 1;
    const updates = {
      'stat-total':       d.total,
      'stat-today':       d.today,
      'stat-groups':      d.groups,
      'stat-dms':         d.dms,
      'stat-admins':      d.adminCount,
      'stat-autoreplies': d.autoRepliesCount,
    };

    for (const [id, val] of Object.entries(updates)) {
      const el = document.getElementById(id);
      if (el) animateNum(el, val);
    }

    const groupSub = document.getElementById('stat-groups-sub');
    if (groupSub) groupSub.textContent = 'of ' + d.total + ' msgs';

    const bannedEl = document.getElementById('stat-banned');
    if (bannedEl) {
      animateNum(bannedEl, d.bannedCount);
      bannedEl.style.color = d.bannedCount > 0 ? 'var(--danger)' : 'inherit';
    }

    const uptimeEl = document.getElementById('stat-uptime');
    if (uptimeEl) uptimeEl.textContent = d.uptime;

    const sb = document.getElementById('senders-body');
    if (sb) sb.innerHTML = renderSenders(d.topSenders, max);

    const lu = document.getElementById('last-update');
    if (lu) lu.textContent = new Date().toLocaleTimeString();
  }

  // ── Bootstrap Loader ───────────────────────────────────────────────────────
  let loaded = false;
  async function initialLoad() {
    try {
      const d = await fetch('/api/stats').then(r => r.json());
      renderOverview(d);
      populateSettingsForm(d.settings);
      renderAutoReplies(d.autoRepliesList);
      renderAdmins(d.admins);
      renderBans(d.bannedList);
      loaded = true;
    } catch(e) {
      document.getElementById('tab-overview').innerHTML = '<div class="err">Failed to load system stats — ' + e.message + '</div>';
    }
  }

  async function loadStatsQuietly() {
    try {
      const d = await fetch('/api/stats').then(r => r.json());
      if (document.getElementById('tab-overview').classList.contains('active')) {
        updateLiveOverview(d);
      }
      populateSettingsForm(d.settings);
      renderAutoReplies(d.autoRepliesList);
      renderAdmins(d.admins);
      renderBans(d.bannedList);
    } catch {}
  }

  // ── SSE Event Handler ──────────────────────────────────────────────────────
  function connectSSE() {
    const es = new EventSource('/api/events');

    es.addEventListener('stats', e => {
      if (!loaded) return;
      try {
        const d = JSON.parse(e.data);
        updateLiveOverview(d);
        // Refresh settings/replies/admins list contents quietly in background
        populateSettingsForm(d.settings);
        renderAutoReplies(d.autoRepliesList);
        renderAdmins(d.admins);
        renderBans(d.bannedList);
      } catch {}
    });

    es.addEventListener('status', e => {
      try {
        const { status, hasQR } = JSON.parse(e.data);
        updateStatusPill(status);
        
        let qrWrap = document.getElementById('qr-section');
        if (hasQR) {
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
            document.querySelector('.tabs-nav').after(qrWrap);
          } else {
            const img = qrWrap.querySelector('img');
            if (img && !img.src.includes('t=')) img.src = '/qr-image?t=' + Date.now();
          }
        } else if (qrWrap) {
          qrWrap.remove();
        }
      } catch {}
    });

    es.addEventListener('heartbeat', () => {});

    es.onerror = () => {
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
      const today = new Date().toISOString().split("T")[0];
      const [
        totalRes, todayRes, groupsRes, recentLogs, 
        admins, banned, autoReplies, settings
      ] = await Promise.all([
        supabase.from("message_logs").select("*", { count: "exact", head: true }),
        supabase.from("message_logs").select("*", { count: "exact", head: true }).gte("sent_at", today),
        supabase.from("message_logs").select("*", { count: "exact", head: true }).eq("is_group", true),
        supabase.from("message_logs").select("number, is_group, sent_at").order("sent_at", { ascending: false }).limit(1000),
        supabase.from("admins").select("number"),
        supabase.from("banned_numbers").select("number, reason"),
        supabase.from("auto_replies").select("keyword, response"),
        supabase.from("settings").select("key, value"),
      ]);

      const total = totalRes.count || 0;
      const todayCount = todayRes.count || 0;
      const groups = groupsRes.count || 0;
      
      const data = recentLogs.data ?? [];
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

// ─── Database Cleanup Tasks ───────────────────────────────────────────────────
setInterval(() => {
  cleanupAntiDeleteStore().catch(err => console.error("Cleanup error:", err));
}, 12 * 60 * 60 * 1000); // Run every 12 hours

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
  console.log(`[Server] Attempting to bind to 0.0.0.0:${PORT}...`);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] 🌐 Web server bound to 0.0.0.0:${PORT}`);
  });
}
