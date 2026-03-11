import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

import { SESSION_DIR, MAX_RECONNECTS, BASE_DELAY_MS } from "./src/config.js";
import { hydrateSessionFromSupabase, saveSessionToSupabase, clearSessionFromSupabase } from "./src/session.js";
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

let botReady    = false;
let currentSock = null;
const startTime = Date.now(); // fix #3 — ignore messages older than bot start

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

// ─── Creds debounce (fix #3) ──────────────────────────────────────────────────

function makeCredsDebounce(saveCreds, state) {
  let timer = null;
  return async () => {
    await saveCreds(); // always save locally immediately
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await saveSessionToSupabase(state.creds, state.keys);
      } catch (err) {
        console.error("❌ Supabase creds save failed:", err.message);
      }
    }, 2000);
  };
}

// ─── SIGINT shutdown (fix #7) ─────────────────────────────────────────────────

// ─── Global crash recovery ────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message);
  console.error(err.stack);
  // Don't exit — let the bot keep running
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection at:", promise);
  console.error("Reason:", reason);
  // Don't exit — let the bot keep running
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
  await hydrateSessionFromSupabase();

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated)"}`);

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", makeCredsDebounce(saveCreds, state));

  sock.ev.on("messaging-history.set", ({ messages }) => {
    console.log(`📥 History sync (${messages.length} msgs) — ignored.`);
  });

  return sock;
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function runBot() {
  let attempt = 1;

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

            if (!botReady) {
              // Fix #2 — botReady properly gates first-time setup
              botReady = true;
              await loadCache();
              startCacheAutoRefresh();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
              startReminderPoller(sock);
              console.log("✅ Bot connected and ready!");
            } else {
              await loadCache();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
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
              console.error("🔄 Connection replaced by newer instance. Exiting cleanly.");
              process.exit(0);
            }

            if (statusCode === DisconnectReason.loggedOut) {
              console.error("🚪 Logged out. Clearing session...");
              await clearSessionFromSupabase();
              botReady = false;
              process.exit(0);
            }

            resolve(true);
          }
        });

        // ─── Messages (fixes #3, #4, #5) ──────────────────────────────────

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
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
                    storeMessage(msg, extractText(msg) ?? "");
                    // Fix #4 — don't await if strict order not required per chat
                    await handleMessage(sock, msg);
                  } catch (err) {
                    console.error("❌ Error processing message:", err.message);
                  }
                }
              })
            )
          );
        });

        // ─── Anti-delete (fix #9) ──────────────────────────────────────────

        sock.ev.on("messages.delete", async (item) => {
          try {
            // Handle all known WhatsApp delete formats
            let keys = [];
            if (item.keys)                    keys = item.keys;
            else if (item.key)                keys = [item.key];
            else if (item.messages)           keys = item.messages.map((m) => m.key).filter(Boolean);

            for (const key of keys) {
              await handleAntiDelete(sock, key);
            }
          } catch (err) {
            console.error("❌ Anti-delete error:", err.message);
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
