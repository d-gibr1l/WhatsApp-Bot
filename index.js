import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

import { SESSION_DIR, MAX_RECONNECTS, BASE_DELAY_MS, botConfig } from "./src/config.js";
import { loadSession, saveSession, clearSession, getAuthState } from "./src/session.js";
import { handleMessage, startReminderPoller, extractText } from "./src/handler.js";
import { loadWordFilter } from "./src/commands/wordfilter.js";
import { loadAllowedLinks } from "./src/commands/antilink.js";
import { loadAliases } from "./src/commands/aliases.js";
import { handleAntiDelete, storeMessage } from "./src/commands/antidelete.js";
import { loadCache, startCacheAutoRefresh } from "./src/cache.js";
import { startServer, setQR, setConnected, setDisconnected, setStarting, setConnecting } from "./src/server.js";

const logger = pino({ level: "silent" });

startServer();

// ─── State ────────────────────────────────────────────────────────────────────

let botReady       = false;
let stopPoller     = null; // cleanup fn for reminder poller
let currentSock = null;
let startTime = Date.now(); // resets on each reconnect — avoids replaying old messages

// ─── Concurrency limiter (fix #5) ────────────────────────────────────────────
// Simple p-limit implementation — no external dependency needed
function makeLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve).catch(reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
const limit = makeLimit(5); // max 5 chats processed simultaneously

// ─── Global crash recovery ────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection at:", promise);
  console.error("Reason:", reason);
});

process.on("SIGINT", async () => {
  console.log("🛑 Shutting down gracefully...");
  if (currentSock) {
    try { currentSock.ev.removeAllListeners(); } catch {}
    try { currentSock.ws?.close(); } catch {}
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received. Shutting down...");
  if (currentSock) {
    try { currentSock.ev.removeAllListeners(); } catch {}
    try { currentSock.ws?.close(); } catch {}
  }
  process.exit(0);
});

// ─── Create Socket ────────────────────────────────────────────────────────────

async function createSocket() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated)"}`);

  const { state, saveCreds } = await getAuthState(); // uses supabase-baileys

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  // saveCreds is provided by supabase-baileys — saves each key update directly to Supabase
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ messages }) => {
    console.log(`📥 History sync (${messages.length} msgs) — ignored.`);
  });

  return sock;
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function runBot() {
  let attempt = 1;

  // ── Startup jitter — prevents multiple Render instances racing to connect ──
  // Each instance waits a random 0–3s before starting so they don't all
  // connect simultaneously and trigger connectionReplaced loops
  const jitter = Math.floor(Math.random() * 3000);
  if (jitter > 0) await new Promise(r => setTimeout(r, jitter));

  // Load session from Supabase into RAM once at startup
  await loadSession();

  while (attempt <= MAX_RECONNECTS) {
    console.log(`🔄 Starting bot (attempt ${attempt})...`);
    setStarting();

    try {
      // Fix #1 — cleanly destroy old socket before creating new one
      if (currentSock) {
        try { currentSock.ev.removeAllListeners(); } catch {}
        try { currentSock.ws?.close(); } catch {}
        currentSock = null;
      }

      const sock = await createSocket();
      currentSock = sock;

      const shouldReconnect = await new Promise((resolve) => {

        // ─── Connection state ──────────────────────────────────────────────

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (connection === "connecting") {
            setConnecting(); // fix #5 — handle connecting state
          }

          // Fix #6 — always update QR, don't debounce (reset edge case fixed)
          if (qr) {
            setQR(qr);
            console.log("📷 QR ready — visit your service URL to scan");
          }

          if (connection === "open") {
            setConnected();
            attempt = 1;

            // Auto-detect BOT_NUMBER from session
            // sock.user.id format: "233XXXXXXXX:123@s.whatsapp.net"
            if (sock.user?.id) {
              const detectedNumber = sock.user.id.split(":")[0].split("@")[0];
              botConfig.BOT_NUMBER = detectedNumber;
              console.log(`📱 Bot number detected: ${detectedNumber}`);
            }

            if (!botReady) {
              // Fix #2 — botReady properly gates first-time setup
              botReady = true;

              // Auto-set super admin: if no admins exist, add bot owner automatically
              try {
                const { getAdmins, addAdmin } = await import("./src/db.js");
                const admins = await getAdmins();
                if (admins.length === 0 && botConfig.BOT_NUMBER) {
                  await addAdmin(botConfig.BOT_NUMBER);
                  console.log(`👑 No admins found — auto-added ${botConfig.BOT_NUMBER} as super admin`);
                }
              } catch (err) {
                console.error("❌ Auto-admin setup failed:", err.message);
              }

              await loadCache();
              startCacheAutoRefresh();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
              if (stopPoller) stopPoller();
              stopPoller = startReminderPoller(sock);
              startTime  = Date.now();
              console.log("✅ Bot connected and ready!");
            } else {
              await loadCache();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
              if (stopPoller) stopPoller();
              stopPoller = startReminderPoller(sock);
              startTime  = Date.now();
              console.log("🔄 Bot reconnected — data refreshed.");
            }
          }

          if (connection === "close") {
            setDisconnected();

            const statusCode =
              lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output.statusCode
                : lastDisconnect?.error?.output?.statusCode;

            const reason =
              Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0] ?? "Unknown";

            console.warn(`⚠️  Disconnected — ${reason} (${statusCode})`);

            if (statusCode === DisconnectReason.connectionReplaced) {
              console.error("🔄 Connection replaced by newer instance. Waiting 10s before exit...");
              await new Promise(r => setTimeout(r, 10000));
              process.exit(0);
            }

            if (statusCode === DisconnectReason.loggedOut) {
              console.error("🚪 Logged out. Clearing session...");
              await clearSession();
              botReady = false;  // allow full re-init on next QR scan
              if (stopPoller) { stopPoller(); stopPoller = null; }
              process.exit(0);
            }

            resolve(true);
          }
        });

        // ─── Messages (fixes #3, #4, #5) ──────────────────────────────────

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
          // Always store messages for anti-delete, regardless of type
          for (const msg of messages) {
            if (msg.message && msg.key?.remoteJid) {
              storeMessage(msg, extractText(msg) ?? "");
            }
          }

          if (type !== "notify") return;

          const byChat = new Map();
          for (const msg of messages) {
            // Fix #3 — skip messages older than bot start time
            const ts = (Number(msg.messageTimestamp) || 0) * 1000;
            if (ts < startTime) continue;

            // Fix #3 — skip messages with no content
            if (!msg.message) continue;

            const jid = msg.key.remoteJid;
            if (!byChat.has(jid)) byChat.set(jid, []);
            byChat.get(jid).push(msg);
          }

          // Fix #5 — limit concurrency to 5 chats at once
          await Promise.all(
            [...byChat.values()].map((chatMsgs) =>
              limit(async () => {
                for (const msg of chatMsgs) {
                  try {
                    // storeMessage already called above for all messages
                    await handleMessage(sock, msg);
                  } catch (err) {
                    console.error("❌ Error processing message:", err.message);
                  }
                }
              })
            )
          );
        });

        // ─── Anti-delete ────────────────────────────────────────────────────
        // Dedup set prevents double-triggering if both events fire for same message
        const recentlyRevoked = new Set();

        async function safeHandleDelete(sock, key) {
          const id = key?.id;
          if (!id || recentlyRevoked.has(id)) return;
          recentlyRevoked.add(id);
          setTimeout(() => recentlyRevoked.delete(id), 5000); // expire after 5s
          await handleAntiDelete(sock, key);
        }

        // messages.delete event (older Baileys versions)
        sock.ev.on("messages.delete", async (item) => {
          try {
            let keys = [];
            if (item.keys)          keys = item.keys;
            else if (item.key)      keys = [item.key];
            else if (item.messages) keys = item.messages.map((m) => m.key).filter(Boolean);
            for (const key of keys) await safeHandleDelete(sock, key);
          } catch (err) {
            console.error("❌ Anti-delete error:", err.message);
          }
        });

        // protocolMessage REVOKE (newer Baileys/WA versions)
        sock.ev.on("messages.upsert", async ({ messages: revokeMsgs, type }) => {
          if (type !== "notify") return;
          for (const msg of revokeMsgs) {
            try {
              const proto = msg.message?.protocolMessage;
              if (proto?.type === 0 && proto?.key) {
                await safeHandleDelete(sock, proto.key);
              }
            } catch (err) {
              console.error("❌ Anti-delete (revoke) error:", err.message);
            }
          }
        });

        // ─── Welcome / Goodbye ───────────────────────────────────────────────
        sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
          try {
            const { getSetting } = await import("./src/db.js");

            for (const participant of participants) {
              const number = participant.split("@")[0];

              if (action === "add") {
                const enabled = await getSetting(`welcome_enabled_${id}`, "false");
                if (enabled !== "true") continue;

                const groupMeta = await sock.groupMetadata(id).catch(() => null);
                const groupName = groupMeta?.subject || "the group";
                const memberName = number;

                let template = await getSetting(`welcome_${id}`, null);
                if (!template) template = `👋 Welcome *{name}* to *{group}*!`;

                const text = template
                  .replace(/{name}/g, memberName)
                  .replace(/{group}/g, groupName)
                  .replace(/{number}/g, number);

                await sock.sendMessage(id, {
                  text,
                  mentions: [participant],
                });

              } else if (action === "remove") {
                const enabled = await getSetting(`goodbye_enabled_${id}`, "false");
                if (enabled !== "true") continue;

                const groupMeta = await sock.groupMetadata(id).catch(() => null);
                const groupName = groupMeta?.subject || "the group";

                let template = await getSetting(`goodbye_${id}`, null);
                if (!template) template = `👋 *{name}* has left *{group}*. Goodbye!`;

                const text = template
                  .replace(/{name}/g, number)
                  .replace(/{group}/g, groupName)
                  .replace(/{number}/g, number);

                await sock.sendMessage(id, { text });
              }
            }
          } catch (err) {
            console.error("❌ Welcome/goodbye error:", err.message);
          }
        });

        // ─── Auto-reject calls ───────────────────────────────────────────────
        sock.ev.on("call", async (calls) => {
          try {
            const { getSetting: getS } = await import("./src/db.js");
            const rejectCalls = await getS("reject_calls", "false");
            if (rejectCalls !== "true") return;
            for (const call of calls) {
              if (call.status === "offer") {
                await sock.rejectCall(call.id, call.from);
                console.log(`📵 Auto-rejected call from ${call.from}`);
              }
            }
          } catch (err) {
            console.error("❌ Call reject error:", err.message);
          }
        });

      }); // end Promise

      if (shouldReconnect) {
        attempt++;
        if (attempt > MAX_RECONNECTS) {
          console.error("❌ Max reconnects reached. Exiting.");
          process.exit(1);
        }
        const delay = Math.min(
          BASE_DELAY_MS * 2 ** (attempt - 2) + Math.random() * 1000,
          60_000
        );
        console.log(`🔁 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }

    } catch (err) {
      console.error("💥 Error in runBot:", err.message);
      attempt++;
      if (attempt > MAX_RECONNECTS) {
        console.error("❌ Too many failures. Exiting.");
        process.exit(1);
      }
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 2), 60_000);
      console.log(`🔁 Retrying in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

runBot();
