import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom }      from "@hapi/boom";
import pino          from "pino";
import { LRUCache }  from "lru-cache";

import { MAX_RECONNECTS, BASE_DELAY_MS, botConfig } from "./src/config.js";
import {
  loadSession,
  clearSession,
  getAuthState,
  drainPendingDbWrites,
  closeMongoConnection,
} from "./src/auth/mongoSession.js";
import { handleMessage, startReminderPoller, extractText } from "./src/handler.js";
import { loadWordFilter }   from "./src/commands/wordfilter.js";
import { loadAllowedLinks } from "./src/commands/antilink.js";
import { loadAliases }      from "./src/commands/aliases.js";
import { handleAntiDelete, storeMessage } from "./src/commands/antidelete.js";
import { loadCache, startCacheAutoRefresh, cachedGetSetting } from "./src/cache.js";
import {
  startServer,
  setQR,
  setConnected,
  setDisconnected,
  setStarting,
  setConnecting,
} from "./src/server.js";
import { updateYtDlp } from "./src/downloader.js";

const logger = pino({ level: "silent" });

startServer();

// ─── State ────────────────────────────────────────────────────────────────────

let botReady        = false;
let stopPoller      = null;
let currentSock     = null;
let lastConnectedAt = 0;

// ─── Concurrency limiter ──────────────────────────────────────────────────────

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
const limit = makeLimit(5);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Single exit path for all signals and error codes.
// Order matters: stop poller → close socket → drain WAL → close MongoDB → exit.

async function shutdown(signal, exitCode = 0) {
  console.log(`Shutting down (${signal}, exit ${exitCode})`);

  if (stopPoller) {
    try { stopPoller(); } catch {}
    stopPoller = null;
  }

  if (currentSock) {
    try { currentSock.ev.removeAllListeners(); } catch {}
    try { currentSock.ws?.close(); } catch {}
    currentSock = null;
  }

  // Drain the MongoDB Write-Ahead Log buffer before closing the connection.
  // This ensures all pending Signal key writes are persisted to MongoDB.
  // Without this, up to `flushIntervalMs` (100ms) of key updates can be lost.
  try {
    await drainPendingDbWrites();
  } catch (err) {
    console.error("⚠️  Final WAL flush failed:", err.message);
  }

  // Close the MongoDB connection pool cleanly
  try {
    await closeMongoConnection();
  } catch (err) {
    console.error("⚠️  MongoDB close failed:", err.message);
  }

  process.exit(exitCode);
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT",  () => shutdown("SIGINT",  0));

// ─── Global crash recovery ────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message, err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// ─── Socket factory ───────────────────────────────────────────────────────────

async function createSocket() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated — update recommended)"}`);

  // getAuthState() bootstraps L1 from MongoDB on first call,
  // then returns the cached instance on reconnects.
  const { state, saveCreds } = await getAuthState();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    markOnlineOnConnect:        false,
    generateHighQualityLinkPreview: false,
    syncFullHistory:             false,
    maxMsgRetryCount:            3,
    connectTimeoutMs:            120_000,
    keepAliveIntervalMs:         25_000,
    defaultQueryTimeoutMs:       60_000,
    retryRequestDelayMs:         2_000,
    // Stub required by Baileys for message retry/poll decryption.
    // Returning an empty string is safe — it prevents crashes without
    // breaking session functionality.
    getMessage: async () => ({ conversation: "" }),
  });

  // saveCreds is wired directly to MongoDB — no debounce, immediate write.
  // CREDS updates are rare and losing one means a full session reset.
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ messages }) => {
    console.log(`History sync: ${messages.length} messages received (ignored).`);
  });

  return sock;
}

// ─── Main reconnect loop ──────────────────────────────────────────────────────

async function runBot() {
  let attempt = 1;

  // Startup jitter — staggers reconnects on Koyeb rolling deploys to prevent
  // multiple instances from hammering WhatsApp servers simultaneously.
  const jitter = Math.floor(Math.random() * 3000);
  if (jitter > 0) {
    console.log(`Startup jitter: ${jitter}ms`);
    await new Promise(r => setTimeout(r, jitter));
  }

  // Update yt-dlp to latest version before launching bot
  try {
    await updateYtDlp();
  } catch (err) {
    console.error("⚠️ Failed to update yt-dlp:", err.message);
  }

  // loadSession() handles FORCE_FRESH_SESSION if set
  await loadSession();

  while (attempt <= MAX_RECONNECTS) {
    console.log(`Connecting (attempt ${attempt}/${MAX_RECONNECTS})...`);
    setStarting();

    // Circuit breaker: if we've made 5+ attempts and never connected once,
    // something is fundamentally wrong (bad creds, network unreachable).
    // Exit cleanly so the process manager can restart with a fresh state.
    if (attempt > 5 && lastConnectedAt === 0) {
      console.error("Circuit breaker: 5+ attempts with no successful connection. Exiting.");
      await shutdown("CIRCUIT_BREAKER", 1);
    }

    try {
      if (currentSock) {
        try { currentSock.ev.removeAllListeners(); } catch {}
        try { currentSock.ws?.close(); } catch {}
        currentSock = null;
      }

      const sock = await createSocket();
      currentSock = sock;

      const shouldReconnect = await new Promise((resolve) => {

        // safeResolve: connection.update fires many times over a socket's
        // lifetime. This Promise resolves exactly once — subsequent calls
        // to safeResolve() are silently no-ops.
        let resolved = false;
        const safeResolve = (value) => {
          if (!resolved) { resolved = true; resolve(value); }
        };

        // ── Connection state machine ───────────────────────────────────────

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (connection === "connecting") setConnecting();

          if (qr) {
            setQR(qr);
            console.log("QR ready — visit your service URL to scan");
          }

          if (connection === "open") {
            setConnected();
            lastConnectedAt = Date.now();
            attempt = 1; // reset counter on successful connect

            if (sock.user?.id) {
              const detectedNumber = sock.user.id.split(":")[0].split("@")[0];
              botConfig.BOT_NUMBER = detectedNumber;
              console.log(`Connected as: ${detectedNumber}`);
            }

            if (!botReady) {
              // First-time setup
              botReady = true;

              try {
                const { getAdmins, addAdmin } = await import("./src/db.js");
                const admins = await getAdmins();
                if (admins.length === 0 && botConfig.BOT_NUMBER) {
                  await addAdmin(botConfig.BOT_NUMBER);
                  console.log(`Auto-added ${botConfig.BOT_NUMBER} as super admin`);
                }
              } catch (err) {
                console.error("Auto-admin setup failed:", err.message);
              }

              await loadCache();
              startCacheAutoRefresh();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
              if (stopPoller) stopPoller();
              stopPoller = startReminderPoller(sock);
              console.log("✅ Bot ready!");

            } else {
              // Reconnect — refresh caches
              await loadCache();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
              if (stopPoller) stopPoller();
              stopPoller = startReminderPoller(sock);
              console.log("🔄 Reconnected — caches refreshed.");
            }
          }

          if (connection === "close") {
            setDisconnected();

            const statusCode =
              lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output.statusCode
                : lastDisconnect?.error?.output?.statusCode;

            const reason =
              Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0]
              ?? "Unknown";

            console.warn(`Disconnected: ${reason} (${statusCode})`);

            // ── 440: connectionReplaced ──────────────────────────────────
            // Another client instance connected with the same session.
            // Wait 15s to let the other instance stabilise, then exit.
            // DO NOT clear session — the new instance may be healthy.
            if (statusCode === DisconnectReason.connectionReplaced) {
              console.warn("⚠️  Session replaced by another instance. Exiting in 15s.");
              await new Promise(r => setTimeout(r, 15_000));
              await shutdown("CONNECTION_REPLACED", 0);
              return;
            }

            // ── 401: loggedOut ────────────────────────────────────────────
            // WhatsApp explicitly revoked the session (user removed linked
            // device from their phone, or account was banned).
            // This is the ONLY code that should trigger a session wipe.
            if (statusCode === DisconnectReason.loggedOut) {
              console.error("🚪 Logged out by WhatsApp. Wiping session for fresh QR.");
              try { await clearSession(); } catch (err) {
                console.error("clearSession failed:", err.message);
              } finally {
                botReady = false;
                if (stopPoller) { stopPoller(); stopPoller = null; }
                await shutdown("LOGGED_OUT", 0);
              }
              return;
            }

            // ── 500: badSession ───────────────────────────────────────────
            // WhatsApp server-side error — almost always transient.
            // DO NOT clear session. The local Signal keys are valid.
            // Reconnect with backoff; if the bot truly had a bad session
            // Baileys will emit 401 (loggedOut) instead.
            if (statusCode === DisconnectReason.badSession) {
              console.warn("⚠️  BadSession (500) — transient server error. Reconnecting (session intact).");
              return safeResolve(true);
            }

            // ── 411: multideviceMismatch ──────────────────────────────────
            // Protocol or library version mismatch. Reconnect — Baileys will
            // re-negotiate. Update @whiskeysockets/baileys if this repeats.
            if (statusCode === 411) {
              console.warn("⚠️  Multidevice mismatch (411). Reconnecting (session intact).");
              return safeResolve(true);
            }

            // ── 428: connectionClosed ─────────────────────────────────────
            // WebSocket closed cleanly — network blip or WA server rotation.
            // Reset the attempt counter if the connection was stable >30s.
            if (statusCode === DisconnectReason.connectionClosed) {
              if (Date.now() - lastConnectedAt > 30_000) {
                console.log("Stable connection lost (428) — resetting attempt counter.");
                attempt = 1;
              }
              return safeResolve(true);
            }

            // ── 515: restartRequired ──────────────────────────────────────
            // WhatsApp proactively requests a reconnect. Non-destructive.
            // Decrement attempt so this doesn't count against MAX_RECONNECTS.
            if (statusCode === DisconnectReason.restartRequired) {
              console.log("Restart requested by WhatsApp (515) — reconnecting immediately.");
              attempt = Math.max(attempt - 1, 1);
              return safeResolve(true);
            }

            // ── 408: timeout ──────────────────────────────────────────────
            // QR scan or keepalive timed out. If we've never successfully
            // connected (waiting for first QR scan), don't burn attempts.
            if (statusCode === 408 && lastConnectedAt === 0) {
              attempt = Math.max(attempt - 1, 1);
              return safeResolve(true);
            }

            // ── All other codes ───────────────────────────────────────────
            // Unknown disconnect — reconnect with standard backoff.
            // Never wipe the session on an unrecognised code.
            console.warn(`Unknown disconnect (${statusCode}) — reconnecting with backoff.`);
            safeResolve(true);
          }
        });

        // ── Messages + Anti-delete (single merged listener) ───────────────
        // Merged to eliminate duplicate registration and make
        // execution order explicit.

        const startTime = Date.now();
        const recentlyRevoked = new LRUCache({ max: 500, ttl: 5000 });

        async function safeHandleDelete(sock, key) {
          const id = key?.id;
          if (!id || recentlyRevoked.has(id)) return;
          recentlyRevoked.set(id, true);
          await handleAntiDelete(sock, key);
        }

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
          // Pass 1: store all messages for anti-delete + detect revokes
          for (const msg of messages) {
            const jid = msg?.key?.remoteJid;
            if (!jid) continue;

            if (msg.message) {
              storeMessage(msg, extractText(msg) ?? "");
            }

            const protoMsg = msg.message?.protocolMessage;
            if (protoMsg?.type === 0 && protoMsg?.key) {
              try {
                await safeHandleDelete(sock, protoMsg.key);
              } catch (err) {
                console.error("Anti-delete (revoke) error:", err.message);
              }
            }
          }

          if (type !== "notify") return;

          // Pass 2: dispatch commands — group by chat, process concurrently
          const byChat = new Map();
          for (const msg of messages) {
            const ts  = (Number(msg.messageTimestamp) || 0) * 1000;
            const jid = msg?.key?.remoteJid;
            if (ts < startTime || !msg.message || !jid) continue;
            if (!byChat.has(jid)) byChat.set(jid, []);
            byChat.get(jid).push(msg);
          }

          await Promise.all(
            [...byChat.values()].map((chatMsgs) =>
              limit(async () => {
                for (const msg of chatMsgs) {
                  try {
                    await handleMessage(sock, msg);
                  } catch (err) {
                    console.error("Error processing message:", err.message);
                  }
                }
              })
            )
          );
        });

        // ── Anti-delete: bulk delete event ────────────────────────────────

        sock.ev.on("messages.delete", async (item) => {
          try {
            let keys = [];
            if (item.keys)          keys = item.keys;
            else if (item.key)      keys = [item.key];
            else if (item.messages) keys = item.messages.map(m => m.key).filter(Boolean);
            for (const key of keys) await safeHandleDelete(sock, key);
          } catch (err) {
            console.error("Anti-delete (bulk) error:", err.message);
          }
        });

        // ── Welcome / Goodbye ─────────────────────────────────────────────

        sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
          try {
            for (const participant of participants) {
              const number = participant.split("@")[0];
              if (action === "add") {
                const enabled = cachedGetSetting(`welcome_enabled_${id}`, "false");
                if (enabled !== "true") continue;
                const groupMeta = await sock.groupMetadata(id).catch(() => null);
                const groupName = groupMeta?.subject || "the group";
                const template  = cachedGetSetting(`welcome_${id}`, `Welcome *{name}* to *{group}*!`);
                const text = template
                  .replace(/{name}/g,   number)
                  .replace(/{group}/g,  groupName)
                  .replace(/{number}/g, number);
                await sock.sendMessage(id, { text, mentions: [participant] });
              } else if (action === "remove") {
                const enabled = cachedGetSetting(`goodbye_enabled_${id}`, "false");
                if (enabled !== "true") continue;
                const groupMeta = await sock.groupMetadata(id).catch(() => null);
                const groupName = groupMeta?.subject || "the group";
                const template  = cachedGetSetting(`goodbye_${id}`, `*{name}* has left *{group}*. Goodbye!`);
                const text = template
                  .replace(/{name}/g,   number)
                  .replace(/{group}/g,  groupName)
                  .replace(/{number}/g, number);
                await sock.sendMessage(id, { text });
              }
            }
          } catch (err) {
            console.error("Welcome/goodbye error:", err.message);
          }
        });

        // ── Auto-reject calls ─────────────────────────────────────────────

        sock.ev.on("call", async (calls) => {
          try {
            const rejectCalls = cachedGetSetting("reject_calls", "false");
            if (rejectCalls !== "true") return;
            for (const call of calls) {
              if (call.status === "offer") {
                await sock.rejectCall(call.id, call.from);
                console.log(`📵 Rejected call from ${call.from}`);
              }
            }
          } catch (err) {
            console.error("Call reject error:", err.message);
          }
        });

      }); // end Promise

      // ── Reconnect backoff ──────────────────────────────────────────────

      if (shouldReconnect) {
        attempt++;
        if (attempt > MAX_RECONNECTS) {
          console.error("Max reconnects reached.");
          await shutdown("MAX_RECONNECTS", 1);
        }
        const delay = Math.min(
          BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000,
          60_000
        );
        console.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        await new Promise(r => setTimeout(r, delay));
      }

    } catch (err) {
      console.error("Fatal error in runBot:", err.message);
      attempt++;
      if (attempt > MAX_RECONNECTS) {
        await shutdown("TOO_MANY_FAILURES", 1);
      }
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000,
        60_000
      );
      console.log(`Retrying in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

runBot();
