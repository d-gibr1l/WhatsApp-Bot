import express from "express";
import qrcode from "qrcode";
import { PORT } from "./config.js";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export let lastQR    = null;
export let botStatus = "starting";

export function setQR(qr)         { lastQR = qr; botStatus = "waiting_qr"; }
export function setConnected()    { lastQR = null; botStatus = "connected"; }
export function setDisconnected() { botStatus = "disconnected"; }
export function setStarting()     { botStatus = "starting"; }

const app = express();

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get("/", (_, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>WhatsApp Bot Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;padding:24px}
    h1{font-size:1.4rem;margin-bottom:4px}
    .sub{color:#64748b;font-size:.85rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:24px 0}
    .card{background:#1a1d2e;border:1px solid #2d3148;border-radius:12px;padding:20px}
    .card h2{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
    .card .val{font-size:2rem;font-weight:700;color:#e2e8f0}
    .card .sub{font-size:.8rem;margin-top:4px}
    .badge{display:inline-block;padding:4px 14px;border-radius:999px;font-size:.78rem;font-weight:600;margin-left:12px;vertical-align:middle}
    .connected{background:#0d2818;color:#22c55e;border:1px solid #16a34a}
    .waiting{background:#2a1f00;color:#f59e0b;border:1px solid #d97706}
    .starting{background:#0d1a2e;color:#60a5fa;border:1px solid #3b82f6}
    .disconnected{background:#2a0d0d;color:#f87171;border:1px solid #dc2626}
    .qr-section{background:#1a1d2e;border:1px solid #2d3148;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px}
    .qr-section img{border-radius:12px;border:4px solid #25d366;width:220px;height:220px}
    .hint{color:#475569;font-size:.8rem;margin-top:12px}
    .section{background:#1a1d2e;border:1px solid #2d3148;border-radius:12px;padding:20px;margin-bottom:16px}
    .section h2{font-size:.85rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th{text-align:left;color:#64748b;font-weight:500;padding:8px 0;border-bottom:1px solid #2d3148}
    td{padding:8px 0;border-bottom:1px solid #1e2132;color:#cbd5e1}
    .refresh{color:#475569;font-size:.75rem;margin-top:4px}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
    .dot.green{background:#22c55e;box-shadow:0 0 6px #22c55e}
    .dot.yellow{background:#f59e0b}
    .dot.blue{background:#60a5fa}
    .dot.red{background:#f87171}
    .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:gap}
    @media(max-width:600px){.grid{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🤖 WhatsApp Bot
        <span class="badge ${botStatus === 'connected' ? 'connected' : botStatus === 'waiting_qr' ? 'waiting' : botStatus === 'disconnected' ? 'disconnected' : 'starting'}">
          <span class="dot ${botStatus === 'connected' ? 'green' : botStatus === 'waiting_qr' ? 'yellow' : botStatus === 'disconnected' ? 'red' : 'blue'}"></span>
          ${botStatus === 'connected' ? 'Connected' : botStatus === 'waiting_qr' ? 'Awaiting Scan' : botStatus === 'disconnected' ? 'Disconnected' : 'Starting'}
        </span>
      </h1>
      <p class="sub">Dashboard • <span id="time"></span></p>
    </div>
    <button onclick="location.reload()" style="background:#2d3148;border:1px solid #3d4168;color:#94a3b8;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:.85rem">↻ Refresh</button>
  </div>

  ${botStatus === "waiting_qr" && lastQR ? `
  <div class="qr-section">
    <p style="color:#f59e0b;font-weight:600;margin-bottom:16px">📱 Scan to connect</p>
    <img src="/qr-image" alt="QR Code"/>
    <p class="hint">Open WhatsApp → Linked Devices → Link a Device</p>
  </div>` : ""}

  <div id="stats">
    <p style="color:#475569;font-size:.85rem">⏳ Loading stats...</p>
  </div>

  <script>
    document.getElementById('time').textContent = new Date().toLocaleString();

    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        const d = await res.json();
        document.getElementById('stats').innerHTML = \`
          <div class="grid">
            <div class="card"><h2>Total Messages</h2><div class="val">\${d.total}</div></div>
            <div class="card"><h2>Today</h2><div class="val">\${d.today}</div></div>
            <div class="card"><h2>Groups</h2><div class="val">\${d.groups}</div></div>
            <div class="card"><h2>DMs</h2><div class="val">\${d.dms}</div></div>
            <div class="card"><h2>Admins</h2><div class="val">\${d.adminCount}</div></div>
            <div class="card"><h2>Banned</h2><div class="val">\${d.bannedCount}</div><div class="sub">numbers</div></div>
            <div class="card"><h2>Uptime</h2><div class="val">\${d.uptime}</div><div class="sub">hh:mm:ss</div></div>
            <div class="card"><h2>Auto Replies</h2><div class="val">\${d.autoReplies}</div></div>
          </div>
          <div class="section">
            <h2>🏆 Top Senders</h2>
            <table>
              <tr><th>Number</th><th>Messages</th><th>Last Seen</th></tr>
              \${d.topSenders.map(s => \`<tr><td>+\${s.number}</td><td>\${s.count}</td><td>\${new Date(s.last).toLocaleString()}</td></tr>\`).join('')}
            </table>
          </div>
          <div class="section">
            <h2>⚙️ Settings</h2>
            <table>
              <tr><th>Key</th><th>Value</th></tr>
              \${d.settings.map(s => \`<tr><td>\${s.key}</td><td>\${['rapidapi_key','groq_api_key','yt_cookies','anthropic_api_key'].includes(s.key) ? '••••••••' : s.value}</td></tr>\`).join('')}
            </table>
          </div>
        \`;
      } catch(e) {
        document.getElementById('stats').innerHTML = '<p style="color:#f87171">Failed to load stats</p>';
      }
    }
    loadStats();
  </script>
</body>
</html>`);
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

    // Top senders
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

    // Uptime
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
