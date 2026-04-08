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

let botReady    = false;
let stopPoller  = null;
let currentSock = null;

// Tracks when the current connection became healthy.
// Used to distinguish a transient blip from "never connected" on 428,
// and to drive the circuit breaker that stops reconnecting if we never
// managed to connect at all.
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
// Single exit path for all cases — SIGTERM, SIGINT, and forced exits.
// Ensures: poller stopped -> socket closed -> lock released ->
//          in-flight saveCreds writes flushed -> Redis quit -> exit.
//
// FIX (#4): All process.exit(1) calls now route here so in-flight Redis
// writes are never killed mid-operation on error exits.

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

  // Release session lock immediately so the next Koyeb instance can acquire
  // it without waiting for the 60s TTL to expire.
  try { await releaseSessionLock(); } catch {}

  // Wait up to 2s for any in-flight saveCreds writes to complete.
  // This is the window that prevents session corruption on SIGTERM.
  await new Promise(r => setTimeout(r, 2000));

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
  console.log(`Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated — update recommended)"}`);

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
    // Returning an empty conversation is a safe stub — prevents crashes without
    // breaking core session functionality.
    getMessage: async () => ({ conversation: "" }),
  });

  // saveCreds is already debounced + error-handled inside session.js
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ messages }) => {
    console.log(`History sync (${messages.length} msgs) — ignored.`);
  });

  return sock;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runBot() {
  let attempt = 1;

  // Startup jitter — prevents multiple Koyeb instances from racing to connect
  // simultaneously. Combined with the Redis session lock, eliminates 440 loops.
  const jitter = Math.floor(Math.random() * 3000);
  if (jitter > 0) {
    console.log(`Startup jitter: ${jitter}ms`);
    await new Promise(r => setTimeout(r, jitter));
  }

  // Session lock — prevents two instances writing to the same Signal session
  // simultaneously. Must happen before makeWASocket, not after.
  const lockAcquired = await acquireSessionLock();
  if (!lockAcquired) {
    console.error("Another instance holds the session lock. Exiting.");
    process.exit(0);
  }

  await loadSession();

  while (attempt <= MAX_RECONNECTS) {
    console.log(`Connecting (attempt ${attempt}/${MAX_RECONNECTS})...`);
    setStarting();

    // FIX (#10): Circuit breaker — if we've made 5+ attempts and never
    // successfully connected, something is fundamentally wrong (bad creds,
    // unreachable network). Stop burning through MAX_RECONNECTS and exit
    // cleanly for a fresh Koyeb restart.
    if (attempt > 5 && lastConnectedAt === 0) {
      console.error("Circuit breaker: 5+ attempts with no successful connection ever. Exiting.");
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

        // FIX (#1): safeResolve guard.
        // connection.update fires multiple times over the socket's lifetime.
        // The Promise resolves only once — JS silently ignores subsequent
        // resolve() calls, making the control flow ambiguous.
        // safeResolve makes the one-shot contract explicit and enforced in code.
        // MUST be declared inside the Promise so `resolve` is in scope.
        let resolved = false;
        const safeResolve = (value) => {
          if (!resolved) {
            resolved = true;
            resolve(value);
          }
        };

        // ── Connection state ───────────────────────────────────────────────

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (connection === "connecting") {
            setConnecting();
          }

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
              console.log("Bot ready!");

            } else {
              await loadCache();
              await loadWordFilter();
              await loadAllowedLinks();
              await loadAliases();
              if (stopPoller) stopPoller();
              stopPoller = startReminderPoller(sock);
              console.log("Reconnected — data refreshed.");
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

            // 440 — another instance took over this session.
            if (statusCode === DisconnectReason.connectionReplaced) {
              console.error("Session taken by another instance. Exiting.");
              await new Promise(r => setTimeout(r, 15_000));
              await shutdown("CONNECTION_REPLACED", 0);
            }

            // 401 — WhatsApp explicitly revoked the session (logged out via phone).
            // Do NOT reconnect — WA rate-limits repeated attempts after 401.
            if (statusCode === DisconnectReason.loggedOut) {
              console.error("Logged out by WhatsApp. Clearing session.");
              try {
                await clearSession();
              } catch (err) {
                console.error("clearSession failed on logout:", err.message);
              } finally {
                botReady = false;
                if (stopPoller) { stopPoller(); stopPoller = null; }
                await shutdown("LOGGED_OUT", 0);
              }
            }

            // 500 — actual corrupted session data.
            // The ONLY code that should clear Redis. NOT 411.
            if (statusCode === DisconnectReason.badSession) {
              console.error("Bad session (500). Clearing for fresh QR.");
              try {
                await clearSession();
              } catch (err) {
                console.error("clearSession failed on badSession:", err.message);
              } finally {
                await shutdown("BAD_SESSION", 1);
              }
            }

            // 411 — multideviceMismatch: library/protocol version mismatch.
            // Clearing Redis here destroys a valid session unnecessarily.
            // Restart so Baileys re-negotiates. Update baileys if this repeats.
            if (statusCode === 411) {
              console.error("Multidevice mismatch (411). Restarting — do NOT clear session.");
              await shutdown("MULTIDEVICE_MISMATCH", 1);
            }

            // 428 — WebSocket closed cleanly (network blip, WA server rotation).
            // Session intact. Reset attempt counter if connection was stable.
            if (statusCode === DisconnectReason.connectionClosed) {
              if (Date.now() - lastConnectedAt > 30_000) {
                console.log("Stable session closed — resetting attempt counter.");
                attempt = 1;
              }
              return safeResolve(true);
            }

            // 515 — WhatsApp requests a restart (normal, non-destructive).
            if (statusCode === DisconnectReason.restartRequired) {
              console.log("Restart required (515) — reconnecting immediately.");
              attempt = Math.max(attempt - 1, 1);
              return safeResolve(true);
            }

            // All other codes (408, 503, unknown) — standard backoff reconnect.
            safeResolve(true);
          }
        });

        // ── Messages + Anti-delete revoke (merged) ─────────────────────────
        // FIX (#8): Previously two separate messages.upsert listeners — one
        // for normal messages, one for protocol revoke detection. Merged into
        // a single handler to eliminate duplicate registration, make execution
        // order explicit, and reduce event emitter overhead.

        const startTime = Date.now();

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
          for (const msg of messages) {
            // FIX (#13): msg.key can be undefined in malformed Baileys events.
            // Without this guard, msg.key.remoteJid throws and crashes the
            // entire handler, silently dropping all messages in the batch.
            const jid = msg?.key?.remoteJid;
            if (!jid) continue;

            // Store all messages for anti-delete, regardless of type.
            if (msg.message) {
              storeMessage(msg, extractText(msg) ?? "");
            }

            // Detect protocol message revoke (sender deleted their message).
            // Previously handled in a separate upsert listener — now inline.
            const proto = msg.message?.protocolMessage;
            if (proto?.type === 0 && proto?.key) {
              try {
                await safeHandleDelete(sock, proto.key);
              } catch (err) {
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

            // FIX (#13): Second guard — different loop context, same risk.
            const jid = msg?.key?.remoteJid;
            if (!jid) continue;

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

        // ── Anti-delete (bulk delete event) ───────────────────────────────
        // Handles messages.delete (older Baileys / WA versions).
        // Protocol revoke is handled above in the merged upsert listener.

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

      // ── Reconnect backoff ────────────────────────────────────────────────

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
        console.error("Too many failures.");
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
