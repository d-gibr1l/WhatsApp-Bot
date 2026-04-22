import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { LRUCache } from "lru-cache";

import { MAX_RECONNECTS, BASE_DELAY_MS, botConfig } from "./src/config.js";
import {
  loadSession,
  clearSession,
  getAuthState,
  acquireSessionLock,
  releaseSessionLock,
  redisClient,
  drainPendingDbWrites,
} from "./src/session.js";
import { handleMessage, startReminderPoller, extractText } from "./src/handler.js";
import { loadWordFilter } from "./src/commands/wordfilter.js";
import { loadAllowedLinks } from "./src/commands/antilink.js";
import { loadAliases } from "./src/commands/aliases.js";
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

  try { await releaseSessionLock(); } catch {}

  // Drain the Supabase write buffer before exit.
  // A blind sleep is not a flush — drainPendingDbWrites() explicitly
  // waits for any in-flight batch and writes all remaining queued rows.
  try {
    await drainPendingDbWrites();
  } catch (err) {
    console.error("⚠️  Final Supabase flush failed:", err.message);
  }

  try { await redisClient.quit(); } catch {}

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
  console.log(`Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated)"}`);

  const { state, saveCreds } = await getAuthState();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    maxMsgRetryCount: 3,
    connectTimeoutMs: 120_000,
    keepAliveIntervalMs: 25_000,
    defaultQueryTimeoutMs: 60_000,
    retryRequestDelayMs: 2_000,
    getMessage: async () => ({ conversation: "" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ messages }) => {
    console.log(`History sync (${messages.length} msgs) — ignored.`);
  });

  return sock;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runBot() {
  let attempt = 1;

  // Startup jitter — prevents multiple instances racing to connect
  const jitter = Math.floor(Math.random() * 3000);
  if (jitter > 0) {
    console.log(`Startup jitter: ${jitter}ms`);
    await new Promise(r => setTimeout(r, jitter));
  }

  const lockAcquired = await acquireSessionLock();
  if (!lockAcquired) {
    console.error("Another instance holds the session lock. Exiting.");
    process.exit(0);
  }

  await loadSession();

  while (attempt <= MAX_RECONNECTS) {
    console.log(`Connecting (attempt ${attempt}/${MAX_RECONNECTS})...`);
    setStarting();

    // Circuit breaker — if 5+ attempts with no successful connection, exit cleanly
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

        // safeResolve — connection.update fires multiple times; Promise resolves once
        let resolved = false;
        const safeResolve = (value) => {
          if (!resolved) { resolved = true; resolve(value); }
        };

        // ── Connection state ───────────────────────────────────────────────

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
            attempt = 1;

            if (sock.user?.id) {
              const detectedNumber = sock.user.id.split(":")[0].split("@")[0];
              botConfig.BOT_NUMBER = detectedNumber;
              console.log(`Connected as: ${detectedNumber}`);
            }

            if (!botReady) {
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
              await loadCache();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
              if (stopPoller) stopPoller();
              stopPoller = startReminderPoller(sock);
              console.log("🔄 Reconnected — data refreshed.");
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

            // ── 440: connectionReplaced ────────────────────────────────────
            // Another instance connected with the same session.
            // Wait 15s (let the other instance stabilise) then exit cleanly.
            // Koyeb restarts this container; the lock will be re-acquired.
            // DO NOT clear session — the other instance may be healthy.
            if (statusCode === DisconnectReason.connectionReplaced) {
              console.warn("⚠️  Session taken by another instance — waiting 15s then exiting.");
              await new Promise(r => setTimeout(r, 15_000));
              await shutdown("CONNECTION_REPLACED", 0);
              return;
            }

            // ── 401: loggedOut ─────────────────────────────────────────────
            // WhatsApp explicitly revoked the session (user removed device
            // from phone, or account banned). The session is permanently
            // invalid — we MUST wipe it and show a new QR.
            // This is the ONLY status code that justifies a session clear.
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

            // ── 500: badSession ────────────────────────────────────────────
            // Baileys maps HTTP 500 (WhatsApp server error) to badSession.
            // This is almost always a TRANSIENT WhatsApp server glitch, not
            // a corrupted local session. Wiping the session and forcing a QR
            // rescan is unnecessary and destructive.
            //
            // PREVIOUS BEHAVIOUR (WRONG):
            //   clearSession() → shutdown("BAD_SESSION", 1)
            //   This deleted healthy Signal keys from all three storage tiers
            //   every time WhatsApp's servers hiccuped, causing unnecessary
            //   QR rescans and session loss.
            //
            // CORRECT BEHAVIOUR:
            //   Reconnect with exponential backoff. The session is intact.
            //   If the bot genuinely had a bad session, Baileys would emit
            //   401 (loggedOut) or the connection would permanently fail to
            //   establish — at which point the circuit breaker exits cleanly.
            if (statusCode === DisconnectReason.badSession) {
              console.warn("⚠️  Received badSession (500) — likely a transient WhatsApp server error. Reconnecting without clearing session.");
              return safeResolve(true);
            }

            // ── 411: multideviceMismatch ───────────────────────────────────
            // Protocol/library version mismatch. Restart so Baileys
            // re-negotiates. DO NOT clear session — the keys are valid.
            // If this repeats, update the @whiskeysockets/baileys package.
            if (statusCode === 411) {
              console.warn("⚠️  Multidevice mismatch (411). Restarting to re-negotiate (session intact).");
              return safeResolve(true);
            }

            // ── 428: connectionClosed ──────────────────────────────────────
            // WebSocket closed cleanly — network blip or WA server rotation.
            // Session is fully intact. Reset attempt counter if we had a
            // stable connection for >30s (prevents slow-burn backoff from
            // accumulating across minor blips).
            if (statusCode === DisconnectReason.connectionClosed) {
              if (Date.now() - lastConnectedAt > 30_000) {
                console.log("Stable connection lost (428) — resetting attempt counter.");
                attempt = 1;
              }
              return safeResolve(true);
            }

            // ── 515: restartRequired ───────────────────────────────────────
            // WhatsApp proactively requests a reconnect (non-destructive).
            // Decrement attempt so this doesn't count against MAX_RECONNECTS.
            if (statusCode === DisconnectReason.restartRequired) {
              console.log("Restart requested by WhatsApp (515) — reconnecting immediately.");
              attempt = Math.max(attempt - 1, 1);
              return safeResolve(true);
            }

            // ── 408: timeout ───────────────────────────────────────────────
            // Connection or QR scan timed out. If we've never successfully
            // connected (lastConnectedAt === 0), don't burn reconnect attempts
            // — we're just waiting for a QR scan.
            if (statusCode === 408 && lastConnectedAt === 0) {
              attempt = Math.max(attempt - 1, 1);
              return safeResolve(true);
            }

            // ── All other codes ────────────────────────────────────────────
            // Unknown disconnect — reconnect with standard backoff.
            // Never clear the session on an unrecognised code.
            console.warn(`Unknown disconnect code (${statusCode}) — reconnecting with backoff.`);
            safeResolve(true);
          }
        });

        // ── Messages + Anti-delete revoke (merged into one listener) ──────

        const startTime = Date.now();

        const recentlyRevoked = new LRUCache({ max: 500, ttl: 5000 });

        async function safeHandleDelete(sock, key) {
          const id = key?.id;
          if (!id || recentlyRevoked.has(id)) return;
          recentlyRevoked.set(id, true);
          await handleAntiDelete(sock, key);
        }

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
          for (const msg of messages) {
            const jid = msg?.key?.remoteJid;
            if (!jid) continue;

            if (msg.message) {
              storeMessage(msg, extractText(msg) ?? "");
            }

            // Detect protocol revoke (sender deleted their message)
            const proto = msg.message?.protocolMessage;
            if (proto?.type === 0 && proto?.key) {
              try { await safeHandleDelete(sock, proto.key); } catch (err) {
                console.error("Anti-delete (revoke) error:", err.message);
              }
            }
          }

          if (type !== "notify") return;

          const byChat = new Map();
          for (const msg of messages) {
            const ts = (Number(msg.messageTimestamp) || 0) * 1000;
            if (ts < startTime) continue;
            if (!msg.message) continue;
            const jid = msg?.key?.remoteJid;
            if (!jid) continue;
            if (!byChat.has(jid)) byChat.set(jid, []);
            byChat.get(jid).push(msg);
          }

          await Promise.all(
            [...byChat.values()].map((chatMsgs) =>
              limit(async () => {
                for (const msg of chatMsgs) {
                  try { await handleMessage(sock, msg); } catch (err) {
                    console.error("Error processing message:", err.message);
                  }
                }
              })
            )
          );
        });

        // ── Anti-delete bulk delete event ──────────────────────────────────

        sock.ev.on("messages.delete", async (item) => {
          try {
            let keys = [];
            if (item.keys)          keys = item.keys;
            else if (item.key)      keys = [item.key];
            else if (item.messages) keys = item.messages.map(m => m.key).filter(Boolean);
            for (const key of keys) await safeHandleDelete(sock, key);
          } catch (err) {
            console.error("Anti-delete error:", err.message);
          }
        });

        // ── Welcome / Goodbye ──────────────────────────────────────────────

        sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
          try {
            for (const participant of participants) {
              const number = participant.split("@")[0];
              if (action === "add") {
                const enabled = cachedGetSetting(`welcome_enabled_${id}`, "false");
                if (enabled !== "true") continue;
                const groupMeta = await sock.groupMetadata(id).catch(() => null);
                const groupName = groupMeta?.subject || "the group";
                const template = cachedGetSetting(`welcome_${id}`, `Welcome *{name}* to *{group}*!`);
                const text = template
                  .replace(/{name}/g, number)
                  .replace(/{group}/g, groupName)
                  .replace(/{number}/g, number);
                await sock.sendMessage(id, { text, mentions: [participant] });
              } else if (action === "remove") {
                const enabled = cachedGetSetting(`goodbye_enabled_${id}`, "false");
                if (enabled !== "true") continue;
                const groupMeta = await sock.groupMetadata(id).catch(() => null);
                const groupName = groupMeta?.subject || "the group";
                const template = cachedGetSetting(`goodbye_${id}`, `*{name}* has left *{group}*. Goodbye!`);
                const text = template
                  .replace(/{name}/g, number)
                  .replace(/{group}/g, groupName)
                  .replace(/{number}/g, number);
                await sock.sendMessage(id, { text });
              }
            }
          } catch (err) {
            console.error("Welcome/goodbye error:", err.message);
          }
        });

        // ── Auto-reject calls ──────────────────────────────────────────────

        sock.ev.on("call", async (calls) => {
          try {
            const rejectCalls = cachedGetSetting("reject_calls", "false");
            if (rejectCalls !== "true") return;
            for (const call of calls) {
              if (call.status === "offer") {
                await sock.rejectCall(call.id, call.from);
                console.log(`Rejected call from ${call.from}`);
              }
            }
          } catch (err) {
            console.error("Call reject error:", err.message);
          }
        });

      }); // end Promise

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
