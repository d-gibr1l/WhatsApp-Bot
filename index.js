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

let botReady   = false;
let stopPoller = null;
let currentSock = null;

// Tracks when the current connection became healthy.
// Used to distinguish "transient blip" from "never connected" on 428.
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
// Handles both Ctrl+C (SIGINT) and Koyeb deploy teardown (SIGTERM).
// SIGTERM is sent by Koyeb on every deploy — without this handler, any
// in-flight saveCreds write is killed mid-operation, corrupting the session.

async function shutdown(signal) {
  console.log(`🛑 ${signal} received — shutting down cleanly`);

  if (stopPoller) {
    try { stopPoller(); } catch {}
    stopPoller = null;
  }

  if (currentSock) {
    try { currentSock.ev.removeAllListeners(); } catch {}
    try { currentSock.ws?.close(); } catch {}
    currentSock = null;
  }

  // Release session lock so the next instance can start immediately
  // instead of waiting for the 60s TTL to expire
  try { await releaseSessionLock(); } catch {}

  // Give any in-flight saveCreds writes up to 2s to complete
  await new Promise(r => setTimeout(r, 2000));

  try { await redisClient.quit(); } catch {}

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─── Global crash recovery ────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message, err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled Rejection:", reason);
});

// ─── Socket factory ───────────────────────────────────────────────────────────

async function createSocket() {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated — update recommended)"}`);

  const { state, saveCreds } = await getAuthState();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    maxMsgRetryCount: 3,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
    retryRequestDelayMs: 5_000,
    // getMessage is required by Baileys for message retry and poll decryption.
    // Without it, failed message deliveries silently look like session errors.
    getMessage: async () => ({ conversation: "" }),
  });

  // saveCreds is already debounced + error-handled inside getAuthState()
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ messages }) => {
    console.log(`📥 History sync (${messages.length} msgs) — ignored.`);
  });

  return sock;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runBot() {
  let attempt = 1;

  // ── Startup jitter ────────────────────────────────────────────────────────
  // Prevents multiple Koyeb instances from racing to connect simultaneously.
  // Combined with the Redis session lock below, this eliminates 440 loops.
  const jitter = Math.floor(Math.random() * 3000);
  if (jitter > 0) {
    console.log(`⏳ Startup jitter: ${jitter}ms`);
    await new Promise(r => setTimeout(r, jitter));
  }

  // ── Session lock ──────────────────────────────────────────────────────────
  // Prevents two instances writing to the same Signal session simultaneously.
  // Must happen before makeWASocket — not after.
  const lockAcquired = await acquireSessionLock();
  if (!lockAcquired) {
    console.error("❌ Another instance holds the session lock. Exiting — Koyeb will restart later.");
    process.exit(0);
  }

  await loadSession();

  while (attempt <= MAX_RECONNECTS) {
    console.log(`🔄 Connecting (attempt ${attempt}/${MAX_RECONNECTS})...`);
    setStarting();

    try {
      // Destroy previous socket cleanly before creating a new one
      if (currentSock) {
        try { currentSock.ev.removeAllListeners(); } catch {}
        try { currentSock.ws?.close(); } catch {}
        currentSock = null;
      }

      const sock = await createSocket();
      currentSock = sock;

      const shouldReconnect = await new Promise((resolve) => {

        // ── Connection state ───────────────────────────────────────────────

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (connection === "connecting") {
            setConnecting();
          }

          if (qr) {
            setQR(qr);
            console.log("📷 QR ready — visit your service URL to scan");
          }

          if (connection === "open") {
            setConnected();
            lastConnectedAt = Date.now();

            // Reset attempt counter — this was a successful connection
            attempt = 1;

            // Detect bot number from WhatsApp session
            if (sock.user?.id) {
              const detectedNumber = sock.user.id.split(":")[0].split("@")[0];
              botConfig.BOT_NUMBER = detectedNumber;
              console.log(`📱 Connected as: ${detectedNumber}`);
            }

            if (!botReady) {
              botReady = true;

              try {
                const { getAdmins, addAdmin } = await import("./src/db.js");
                const admins = await getAdmins();
                if (admins.length === 0 && botConfig.BOT_NUMBER) {
                  await addAdmin(botConfig.BOT_NUMBER);
                  console.log(`👑 Auto-added ${botConfig.BOT_NUMBER} as super admin`);
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

            console.warn(`⚠️  Disconnected: ${reason} (${statusCode})`);

            // ── Disconnect handling ──────────────────────────────────────
            // Each code has a distinct cause and correct response.
            // Getting these wrong is the #1 source of session corruption loops.

            // 440 — another instance took over this session
            // Our 60s lock TTL + jitter should prevent this, but handle it anyway.
            if (statusCode === DisconnectReason.connectionReplaced) {
              console.error("🔁 Session taken by another instance. Releasing lock and exiting.");
              await releaseSessionLock();
              // Wait longer than jitter window so the new instance fully establishes
              await new Promise(r => setTimeout(r, 15_000));
              process.exit(0);
            }

            // 401 — WhatsApp explicitly revoked this session (user logged out via phone)
            // Do NOT reconnect — WhatsApp rate-limits repeated reconnect attempts after 401.
            if (statusCode === DisconnectReason.loggedOut) {
              console.error("🚪 Logged out by WhatsApp. Clearing session.");
              try {
                await clearSession();
              } catch (err) {
                console.error("❌ clearSession failed on logout:", err.message);
              } finally {
                await releaseSessionLock();
                botReady = false;
                if (stopPoller) { stopPoller(); stopPoller = null; }
                process.exit(0);
              }
            }

            // 500 — actual bad/corrupted session data
            // This is the correct code to clear Redis on, NOT 411.
            if (statusCode === DisconnectReason.badSession) {
              console.error("💀 Bad session (500). Clearing session for fresh QR.");
              try {
                await clearSession();
              } catch (err) {
                console.error("❌ clearSession failed on badSession:", err.message);
              } finally {
                await releaseSessionLock();
                process.exit(1);
              }
            }

            // 411 — multideviceMismatch: protocol/library version mismatch.
            // Clearing the session here DESTROYS a valid session unnecessarily.
            // The correct response is to restart the process (Baileys re-negotiates)
            // and update the library if this repeats.
            if (statusCode === 411) {
              console.error("⚠️  Multidevice mismatch (411). Restarting process (do NOT clear session).");
              await releaseSessionLock();
              process.exit(1); // Koyeb restarts → fresh negotiation attempt
            }

            // 428 — WebSocket closed cleanly (network blip, WA server rotation)
            // Session is intact. If we were connected long enough, reset attempt counter.
            if (statusCode === DisconnectReason.connectionClosed) {
              if (Date.now() - lastConnectedAt > 30_000) {
                console.log("📶 Connection closed after stable session — resetting attempt counter.");
                attempt = 1;
              }
              return resolve(true);
            }

            // 515 — WhatsApp asks us to restart (normal, non-destructive)
            if (statusCode === DisconnectReason.restartRequired) {
              console.log("♻️  Restart required (515) — reconnecting immediately.");
              attempt = Math.max(attempt - 1, 1); // don't penalise attempt count for WA-initiated restarts
              return resolve(true);
            }

            // All other codes (408 timedOut, 503, unknown) — standard reconnect
            resolve(true);
          }
        });

        // ── Messages ───────────────────────────────────────────────────────

        const startTime = Date.now();

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
          // Store all messages for anti-delete regardless of type
          for (const msg of messages) {
            if (msg.message && msg.key?.remoteJid) {
              storeMessage(msg, extractText(msg) ?? "");
            }
          }

          if (type !== "notify") return;

          const byChat = new Map();
          for (const msg of messages) {
            const ts = (Number(msg.messageTimestamp) || 0) * 1000;
            if (ts < startTime) continue;
            if (!msg.message) continue;
            const jid = msg.key.remoteJid;
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
                    console.error("❌ Error processing message:", err.message);
                  }
                }
              })
            )
          );
        });

        // ── Anti-delete ────────────────────────────────────────────────────

        const recentlyRevoked = new LRUCache({ max: 500, ttl: 5000 });

        async function safeHandleDelete(sock, key) {
          const id = key?.id;
          if (!id || recentlyRevoked.has(id)) return;
          recentlyRevoked.set(id, true);
          await handleAntiDelete(sock, key);
        }

        sock.ev.on("messages.delete", async (item) => {
          try {
            let keys = [];
            if (item.keys)          keys = item.keys;
            else if (item.key)      keys = [item.key];
            else if (item.messages) keys = item.messages.map(m => m.key).filter(Boolean);
            for (const key of keys) await safeHandleDelete(sock, key);
          } catch (err) {
            console.error("❌ Anti-delete error:", err.message);
          }
        });

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
                const template = cachedGetSetting(`welcome_${id}`, `👋 Welcome *{name}* to *{group}*!`);
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
                const template = cachedGetSetting(`goodbye_${id}`, `👋 *{name}* has left *{group}*. Goodbye!`);
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

        // ── Auto-reject calls ──────────────────────────────────────────────

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
            console.error("❌ Call reject error:", err.message);
          }
        });

      }); // end Promise

      // ── Reconnect backoff ────────────────────────────────────────────────

      if (shouldReconnect) {
        attempt++;
        if (attempt > MAX_RECONNECTS) {
          console.error("❌ Max reconnects reached. Releasing lock and exiting.");
          await releaseSessionLock();
          process.exit(1);
        }
        // Fixed: exponent starts at 0 so attempt=1 gives BASE_DELAY_MS * 1, not 0.5x
        const delay = Math.min(
          BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000,
          60_000
        );
        console.log(`🔁 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        await new Promise(r => setTimeout(r, delay));
      }

    } catch (err) {
      console.error("💥 Fatal error in runBot:", err.message);
      attempt++;
      if (attempt > MAX_RECONNECTS) {
        console.error("❌ Too many failures. Releasing lock and exiting.");
        await releaseSessionLock();
        process.exit(1);
      }
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000,
        60_000
      );
      console.log(`🔁 Retrying in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

runBot();