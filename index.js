import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom }      from "@hapi/boom";
import pino          from "pino";
import fs            from "fs/promises";
import os            from "os";
import path          from "path";

import { MAX_RECONNECTS, BASE_DELAY_MS, botConfig } from "./src/config.js";
import {
  loadSession,
  clearSession,
  getAuthState,
  drainPendingDbWrites,
  closeRedisConnection,
  purgeCorruptKey,
  purgeAllKeysForJid,
  getSessionId,
} from "./src/auth/redisSession.js";
import { installBadMacInterceptor, uninstallBadMacInterceptor } from "./src/auth/badMacInterceptor.js";
import { startReminderPoller, markBotReady, resetBotReady } from "./src/handler.js";
import { startRadarEngine, stopRadarEngine } from "./src/commands/radar.js";
import { loadWordFilter }   from "./src/commands/wordfilter.js";
import { loadAllowedLinks } from "./src/commands/antilink.js";
import { loadAliases }      from "./src/commands/aliases.js";
import { bindMessagesEvents } from "./src/events/messages.js";
import { bindGroupEvents }    from "./src/events/groups.js";
import { bindCallEvents }     from "./src/events/calls.js";
import { loadCache, startCacheAutoRefresh, loadSeenMessages } from "./src/cache.js";
import {
  startServer,
  setQR,
  setConnected,
  setDisconnected,
  setStarting,
  setConnecting,
} from "./src/server.js";
import { updateYtDlp } from "./src/downloader.js";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

startServer();

// Install Bad MAC interceptor immediately — before any socket is created.
// This ensures even the very first connection's decryption errors are caught.
installBadMacInterceptor(purgeCorruptKey, getSessionId, purgeAllKeysForJid);

async function cleanupTmpDir() {
  try {
    const tmpDir = os.tmpdir();
    const files = await fs.readdir(tmpDir);
    const now = Date.now();
    let deleted = 0;
    
    for (const file of files) {
      if (file.startsWith("dl_")) {
        const filePath = path.join(tmpDir, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > 60 * 60 * 1000) { // older than 1 hour
          await fs.unlink(filePath).catch(() => {});
          deleted++;
        }
      }
    }
    if (deleted > 0) console.log(`[System] Swept ${deleted} orphaned temp file(s).`);
  } catch (err) {
    console.error("[System] Error sweeping tmp dir:", err.message);
  }
}
cleanupTmpDir();
setInterval(cleanupTmpDir, 60 * 60 * 1000); // Run every hour

// ─── State ────────────────────────────────────────────────────────────────────

let botReady        = false;
let stopPoller      = null;
let currentSock     = null;
let lastConnectedAt = 0;
let botReadyTimer   = null;

/**
 * Safely extracts HTTP / Baileys disconnect status code from Boom objects,
 * error properties, error codes, and nested error causes.
 */
function extractStatusCode(error) {
  if (!error) return undefined;
  if (error instanceof Boom || error?.output?.statusCode) {
    return error.output?.statusCode;
  }
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  if (typeof error.code === "string" && !isNaN(Number(error.code))) {
    return Number(error.code);
  }
  if (error.cause) {
    return extractStatusCode(error.cause);
  }
  return undefined;
}

function teardownCurrentSocket(sock) {
  if (botReadyTimer) {
    clearTimeout(botReadyTimer);
    botReadyTimer = null;
  }

  // 1. Reset ready state immediately
  resetBotReady();

  // 2. Stop active background timers and pollers
  if (stopPoller) {
    try { stopPoller(); } catch {}
    stopPoller = null;
  }
  try { stopRadarEngine(); } catch {}

  // 3. Forceful socket and listener teardown
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.ws?.close(); } catch {}
    try { sock.ws?.terminate(); } catch {}
  }
  if (currentSock === sock) {
    currentSock = null;
  }
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────
// Removed makeLimit: using ChatQueueManager inside src/events/messages.js instead.

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Single exit path for all signals and error codes.
// Order matters: stop poller → close socket → uninstall interceptor → drain Redis → close Redis → exit.

let isShuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Shutting down (${signal}, exit ${exitCode})`);

  if (stopPoller) {
    try { stopPoller(); } catch (err) { console.error("Error stopping poller:", err.message); }
    stopPoller = null;
  }

  if (currentSock) {
    try { currentSock.ev.removeAllListeners(); } catch (err) { console.error("Error removing listeners:", err.message); }
    try { currentSock.ws?.close(); } catch (err) { console.error("Error closing socket:", err.message); }
    currentSock = null;
  }

  // Restore the original console methods and remove the unhandledRejection
  // listener that the Bad MAC interceptor installed.
  try {
    uninstallBadMacInterceptor();
  } catch (err) { console.error("Error uninstalling interceptor:", err.message); }

  // Drain pending Redis writes before closing the connection.
  // keys.set and saveCreds write-through immediately, but "issued" is not
  // "acknowledged" — anything still in-flight would be lost on close.
  try {
    await drainPendingDbWrites();
  } catch (err) {
    console.error("⚠️  Final Redis flush failed:", err.message);
  }

  // Close the Redis connection cleanly
  try {
    await closeRedisConnection();
  } catch (err) {
    console.error("⚠️  Redis close failed:", err.message);
  }

  process.exit(exitCode);
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT",  () => shutdown("SIGINT",  0));

// ─── Global crash recovery ────────────────────────────────────────────────────

process.on("uncaughtException", async (err) => {
  console.error("💥 Uncaught Exception:", err?.message || err, err?.stack || "");
  try {
    teardownCurrentSocket(currentSock);
  } catch (tErr) {
    console.error("Error tearing down socket during uncaughtException:", tErr.message);
  }
  await shutdown("UNCAUGHT_EXCEPTION", 1);
});

// Note: unhandledRejection listener is managed uniformly by installBadMacInterceptor.

// ─── Socket factory ───────────────────────────────────────────────────────────

async function createSocket() {
  let version = [2, 3000, 1015901307];
  let isLatest = false;
  try {
    const vResult = await fetchLatestBaileysVersion();
    version = vResult.version;
    isLatest = vResult.isLatest;
    console.log(`📦 Baileys ${version.join(".")} ${isLatest ? "(latest)" : "(outdated — update recommended)"}`);
  } catch (err) {
    console.warn(`⚠️ Could not fetch latest Baileys version (${err?.message || err}). Using fallback version ${version.join(".")}`);
  }

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

  // saveCreds is wired directly to Redis — no debounce, immediate write.
  // CREDS updates are rare and losing one means a full session reset.
  sock.ev.on("creds.update", (...args) => {
    saveCreds(...args).catch((err) => {
      console.error("⚠️ Failed to save creds update:", err.message);
    });
  });

  sock.ev.on("messaging-history.set", ({ messages }) => {
    console.log(`History sync: ${messages.length} messages received (ignored).`);
  });

  return sock;
}

// ─── Main reconnect loop ──────────────────────────────────────────────────────

async function runBot() {
  let attempt = 1;
  let sessionLoaded = false;

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
      if (!sessionLoaded) {
        await loadSession();
        sessionLoaded = true;
      }
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

            try {
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
                startRadarEngine(sock);
                console.log("✅ Bot ready! Loading seen messages and waiting 3s for sync...");
                // Load previously processed message IDs from Redis
                await loadSeenMessages();
                // Give WhatsApp 3 seconds to flush historical messages
                // before we start processing commands
                if (botReadyTimer) clearTimeout(botReadyTimer);
                botReadyTimer = setTimeout(() => {
                  markBotReady();
                  botReadyTimer = null;
                }, 3000);

              } else {
                // Reconnect — refresh caches
                await loadCache();
                await loadWordFilter();
                await loadAllowedLinks();
                await loadAliases();
                if (stopPoller) stopPoller();
                stopPoller = startReminderPoller(sock);
                startRadarEngine(sock);
                console.log("🔄 Reconnected — caches refreshed. Waiting 3s for sync...");
                await loadSeenMessages();
                if (botReadyTimer) clearTimeout(botReadyTimer);
                botReadyTimer = setTimeout(() => {
                  markBotReady();
                  botReadyTimer = null;
                }, 3000);
              }
            } catch (setupErr) {
              console.error("⚠️ Connection setup error:", setupErr?.message || setupErr);
            }
          }

          if (connection === "close") {
            setDisconnected();
            teardownCurrentSocket(sock);

            const statusCode = extractStatusCode(lastDisconnect?.error);

            const reason =
              Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0]
              ?? "Unknown";

            const errorMsg = lastDisconnect?.error?.message ?? (lastDisconnect?.error ? String(lastDisconnect.error) : "No error details");
            const stackMsg = lastDisconnect?.error?.stack ? `\n${lastDisconnect.error.stack}` : "";
            console.warn(`Disconnected: ${reason} (${statusCode}) - Error: ${errorMsg}${stackMsg}`);

            // ── 440: connectionReplaced ──────────────────────────────────
            // Another instance connected with the same session (Koyeb rolling
            // deploy). WhatsApp only sends this AFTER the new instance is
            // healthy, so we can shut down immediately — no wait needed.
            //
            // The previous 15-second wait was the cause of "two instances
            // running at the same time": both were advancing the same Signal
            // ratchet keys for 15s, producing Bad MAC errors on the new
            // instance. Now we drain the WAL and exit in ~1s.
            //
            // DO NOT clear session — the new instance is healthy and owns it.
            if (statusCode === DisconnectReason.connectionReplaced) {
              console.warn("⚠️  Session replaced by another instance. Shutting down immediately.");
              await shutdown("CONNECTION_REPLACED", 0);
              return;
            }


            // ── Fatal & Unrecoverable Disconnect Codes (401, 403, 405, 409, 412) ──
            // These indicate unrecoverable session degradation, server-side revoking,
            // or permanent key out-of-sync states. Trigger session wipe for fresh QR.
            const fatalCodes = [
              DisconnectReason.loggedOut, // 401
              403,                        // Forbidden (e.g. banned/device revoked)
              405,                        // Method Not Allowed
              409,                        // Conflict / State mismatch
              412                         // Precondition Failed (device out of sync)
            ];
            if (fatalCodes.includes(statusCode)) {
              console.error(`🚪 Unrecoverable disconnect code received: ${reason} (${statusCode}). Wiping session for fresh QR.`);
              try { await clearSession(); } catch (err) {
                console.error("clearSession failed:", err.message);
              } finally {
                botReady = false;
                if (stopPoller) { stopPoller(); stopPoller = null; }
                await shutdown("FATAL_DISCONNECT", 0);
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
            // Reset attempt counter so clean disconnects never exhaust reconnects.
            if (statusCode === DisconnectReason.connectionClosed || statusCode === 428) {
              console.log("Connection closed (428) — resetting attempt counter.");
              attempt = 1;
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

            // ── 408: timeout / connectionLost ─────────────────────────────
            // Socket timed out or keepalive failed.
            // Decrement attempt so this doesn't count against MAX_RECONNECTS,
            // whether on initial startup or on an established connection.
            if (statusCode === DisconnectReason.connectionLost || statusCode === 408) {
              console.log("Connection lost / timed out (408) — reconnecting (preserving attempt count).");
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

        // ── Events ───────────────────────────────────────────────────────
        bindMessagesEvents(sock);
        bindGroupEvents(sock);
        bindCallEvents(sock);

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

runBot().catch((err) => console.error("Unhandled error in runBot:", err));
