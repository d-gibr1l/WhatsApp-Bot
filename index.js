import "./Configurations.js";
import ffmpegStatic from "ffmpeg-static";
if (process.platform === "win32") {
  process.env.FFMPEG_PATH = ffmpegStatic;
}
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  downloadMediaMessage,
  jidDecode,
} from "@whiskeysockets/baileys";
import MongoAuth from "./System/MongoAuth/MongoAuth.js";
import fs from "fs";
import figlet from "figlet";
import { join } from "path";
import got from "got";
import pino from "pino";
import path from "path";
import { fileTypeFromBuffer } from "file-type";
import { Boom } from "@hapi/boom";
import { serialize, WAConnection } from "./System/whatsapp.js";
import { smsg, getBuffer, getSizeMedia } from "./System/Function2.js";
import InstanceLock from "./System/InstanceLock.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

fs.writeFileSync(path.join(__dirname, "hooper.pid"), process.pid.toString());

// Map of noise prefixes → clean replacement line printed to stdout once per event
const _BAILEYS_NOISE_MAP = {
  "Failed to decrypt message with any known session":
    "[ HOOPER ] Signal: failed to decrypt (session key mismatch — skipped)",
  "Session error:": "[ HOOPER ] Signal: session error (Bad MAC — skipped)",
  "Closing open session in favor of incoming prekey bundle":
    "[ HOOPER ] Signal: rotating session (new prekey bundle received)",
  "Closing session:": null, // suppress entirely — too verbose (raw key dump)
  "Opening session:": null,
};

const _matchNoise = (str) => {
  for (const [prefix, replacement] of Object.entries(_BAILEYS_NOISE_MAP)) {
    if (str.startsWith(prefix)) return { matched: true, replacement };
  }
  return { matched: false };
};

// Patch console.log (stdout)
const _origLog = console.log;
console.log = (...args) => {
  const first = String(args[0] ?? "");
  const { matched, replacement } = _matchNoise(first);
  if (matched) {
    if (replacement) _origLog(replacement);
    return;
  }
  _origLog(...args);
};

// Patch console.error (stderr) — libsignal uses this path
const _origErr = console.error;
console.error = (...args) => {
  const first = String(args[0] ?? "");
  const { matched, replacement } = _matchNoise(first);
  if (matched) {
    if (replacement) _origLog(replacement); // route clean msg to stdout
    return;
  }
  _origErr(...args);
};

// Patch console.info — libsignal uses console.info("Closing session:", session)
const _origInfo = console.info;
console.info = (...args) => {
  const first = String(args[0] ?? "");
  const { matched, replacement } = _matchNoise(first);
  if (matched) {
    if (replacement) _origLog(replacement);
    return;
  }
  _origInfo(...args);
};

// Patch process.stderr.write — final fallback used by some internal Node streams
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const str = typeof chunk === "string" ? chunk : chunk.toString();
  const { matched, replacement } = _matchNoise(str.trimStart());
  if (matched) {
    if (replacement) _origLog(replacement);
    return true;
  }
  return _origStderrWrite(chunk, ...rest);
};

import express from "express";
const app = express();
const PORT = global.port;
import welcomeLeft from "./System/Welcome.js";
import { readcommands, commands } from "./System/ReadCommands.js";
import core from "./Core.js";
commands.prefix = global.prefa;
import mongoose from "mongoose";
import qrcode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import {
  getPluginURLs,
  checkAntidelete,
  checkMod,
} from "./System/MongoDB/MongoDb_Core.js";
import chalk from "chalk";
import { spawn } from "child_process";
import { createDashboardAuth } from "./src/dashboard-auth.js";

if (fs.existsSync("./wireproxy.conf")) {
  console.log(chalk.cyan("[ HOOPER ] Starting Wireproxy SOCKS5 proxy..."));
  const wp = spawn("wireproxy", ["-c", "wireproxy.conf"], { stdio: "inherit" });
  wp.on("error", (e) => console.log(chalk.red("[ HOOPER ] Wireproxy start failed: " + e.message)));
}

app.use(express.json());

// ─── Dashboard auth ─────────────────────────────────────────────────────────
// Every /api/* route below controls the live WhatsApp session (QR, pairing,
// clear-session) or exposes secrets (/api/config), so the whole surface is
// gated behind a password. Priority: DASHBOARD_PASSWORD env var (fixed), then
// a hash the operator sets on first visit ("setup" mode). The stored hash is
// loaded from the DB later in initConfigAndStart().
const DASHBOARD_ENV_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim() || null;
const dashboardAuth = createDashboardAuth({
  envPassword: DASHBOARD_ENV_PASSWORD,
  persistHash: async (hash) => {
    const mod = await import("./src/db.js");
    await mod.setSetting("dashboard_password_hash", hash);
  },
});
if (DASHBOARD_ENV_PASSWORD) {
  console.log(chalk.green(`[ HOOPER ] Dashboard auth: using DASHBOARD_PASSWORD from environment.`));
}

global.lidToJidMap = new Map();

// Baileys can emit "messages.update" more than once for the same revoke
// (multi-device fan-out, reconnect replays). Module-scoped so it survives
// socket reconnects, unlike the handler closure itself.
const REVOKE_DEDUP_TTL_MS = 10_000;
const recentlyRevoked = new Map(); // `${chatId}:${id}` -> timeout handle
function isDuplicateRevoke(dedupKey) {
  if (recentlyRevoked.has(dedupKey)) return true;
  const timer = setTimeout(() => recentlyRevoked.delete(dedupKey), REVOKE_DEDUP_TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
  recentlyRevoked.set(dedupKey, timer);
  return false;
}

const MESSAGE_CACHE_TTL_MS =
  Math.max(
    30,
    parseInt(process.env.MESSAGE_CACHE_TTL_MINUTES || "360", 10) || 360,
  ) *
  60 *
  1000;
const MESSAGE_CACHE_MAX_PER_CHAT = Math.max(
  50,
  parseInt(process.env.MESSAGE_CACHE_MAX_PER_CHAT || "500", 10) || 500,
);

import { messageData, contactData } from "./System/MongoDB/MongoDB_Schema.js";
import { resolveParties, pickMedia, sanitizeMentions } from "./src/antidelete-helpers.js";

const store = {
  bind(ev) {
    let _lidLogTimer = null;
    ev.on("contacts.upsert", async (contacts) => {
      const ops = [];
      for (const contact of contacts) {
        ops.push({
          updateOne: {
            filter: { id: contact.id },
            update: { $set: contact },
            upsert: true
          }
        });
        const phoneJid = contact.id?.endsWith("@s.whatsapp.net") ? contact.id : null;
        const lidJid = contact.id?.endsWith("@lid") ? contact.id : contact.lid?.endsWith("@lid") ? contact.lid : null;
        if (phoneJid && lidJid) {
          global.lidToJidMap.set(lidJid, phoneJid);
          global.lidToJidMap.set(phoneJid, lidJid);
        }
      }
      if (ops.length > 0) {
        try { await contactData.bulkWrite(ops, { ordered: false }); } catch (e) {}
      }
      
      clearTimeout(_lidLogTimer);
      _lidLogTimer = setTimeout(() => {
        if (global.lidToJidMap.size > 0)
          _origLog(`[ HOOPER ] LID map ready: ${global.lidToJidMap.size / 2} contact(s) mapped`);
      }, 300);
    });
    
    ev.on("contacts.update", async (updates) => {
      const ops = [];
      for (const update of updates) {
        ops.push({
          updateOne: {
            filter: { id: update.id },
            update: { $set: update },
            upsert: true
          }
        });
        const phoneJid = update.id?.endsWith("@s.whatsapp.net") ? update.id : null;
        const lidJid = update.lid?.endsWith("@lid") ? update.lid : update.id?.endsWith("@lid") ? update.id : null;
        if (phoneJid && lidJid) {
          global.lidToJidMap.set(lidJid, phoneJid);
          global.lidToJidMap.set(phoneJid, lidJid);
        }
      }
      if (ops.length > 0) {
        try { await contactData.bulkWrite(ops, { ordered: false }); } catch (e) {}
      }
    });

    ev.on("messages.upsert", async ({ messages }) => {
      const ops = [];
      for (const msg of messages) {
        if (!msg.key?.remoteJid || !msg.key?.id) continue;
        // Status updates aren't revoke-able chat messages (anti-delete never
        // fires for status@broadcast) and are handled by their own forwarder
        // above; skip them here so the store isn't flooded with statuses.
        // fromMe messages ARE still stored — quote-reply lookups
        // (Function2.js's getQuotedMessage -> store.loadMessage) need them
        // when a user replies to something the bot sent.
        if (msg.key.remoteJid === "status@broadcast") continue;
        ops.push({
          updateOne: {
            filter: { id: msg.key.id, chatId: msg.key.remoteJid },
            update: { $set: { participant: msg.key.participant || null, data: msg } },
            upsert: true
          }
        });
      }
      if (ops.length > 0) {
        try { await messageData.bulkWrite(ops, { ordered: false }); } catch (e) {}
      }
    });
  },
  loadMessage: async (jid, id) => {
    try {
      const doc = await messageData.findOne({ id, chatId: jid }).lean();
      if (!doc) return null;
      
      const reviveBuffers = (obj) => {
         if (!obj || typeof obj !== 'object') return obj;
         if (Buffer.isBuffer(obj)) return obj;
         if (obj._bsontype === 'Binary' && obj.buffer) return Buffer.from(obj.buffer);
         if (obj.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
         for (const k in obj) obj[k] = reviveBuffers(obj[k]);
         return obj;
      };
      
      return reviveBuffers(doc.data);
    } catch {
      return null;
    }
  }
};

// Hooper Server configuration
let QR_GENERATE = "invalid";
let status = "initializing";
let HooperSocket = null; // module-level reference for pairing API
let mongoAuth; // module-level so the GC/sync interval can access it
let clearAuthState = null;
let startPromise = null;
let instanceLock = null;
let restartTimer = null;
let pendingClearAuth = false;
let reconnectAttempt = 0;
let activeSocketGeneration = 0;
let socketGeneration = 0;
let socketStartedAt = 0;
let lastConnectionUpdateAt = Date.now();
let healthProbeFailures = 0;
let healthProbeRunning = false;
let stableConnectionTimer = null;
let shuttingDown = false;
let periodicSyncPromise = null;
let sessionSyncPaused = false;

const KEEP_ALIVE_INTERVAL_MS = 25_000;
const WATCHDOG_INTERVAL_MS =
  Math.max(
    30,
    Math.min(
      600,
      parseInt(process.env.WATCHDOG_INTERVAL_SECONDS || "60", 10) || 60,
    ),
  ) * 1000;
const HEALTH_QUERY_TIMEOUT_MS = 15_000;
const HEALTH_FAILURE_THRESHOLD = 2;
const CONNECT_STALL_TIMEOUT_MS = 180_000;
const SOCKET_CLOSE_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 60_000;
const STABLE_CONNECTION_MS = 300_000;

const isCurrentSocket = (socket, generation) =>
  HooperSocket === socket && activeSocketGeneration === generation;

const clearStableConnectionTimer = () => {
  if (stableConnectionTimer) {
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
  }
};

const markConnectionStableLater = (socket, generation) => {
  clearStableConnectionTimer();
  stableConnectionTimer = setTimeout(() => {
    if (isCurrentSocket(socket, generation) && status === "open") {
      reconnectAttempt = 0;
      console.log(chalk.green(`[ HOOPER ] Connection stable - backoff reset`));
    }
  }, STABLE_CONNECTION_MS);
  stableConnectionTimer.unref?.();
};

const closeActiveSocket = async (reason) => {
  const socket = HooperSocket;
  if (!socket) return;

  HooperSocket = null;
  activeSocketGeneration = 0;
  socketStartedAt = 0;
  healthProbeFailures = 0;
  clearStableConnectionTimer();

  try {
    const endPromise = socket.end(
      new Boom(reason, {
        statusCode: DisconnectReason.connectionClosed,
      }),
    );
    const closedCleanly = await Promise.race([
      endPromise.then(() => true),
      new Promise((resolve) =>
        setTimeout(() => resolve(false), SOCKET_CLOSE_TIMEOUT_MS),
      ),
    ]);

    if (!closedCleanly) {
      console.log(
        chalk.yellow(
          `[ HOOPER ] Socket close timed out - forcing WebSocket termination`,
        ),
      );
      socket.ws?.socket?.terminate?.();
      await Promise.race([
        endPromise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  } catch (err) {
    console.error(
      chalk.redBright(`[ HOOPER ] Socket cleanup error: ${err.message}`),
    );
  }
};

const getReconnectDelay = (immediate) => {
  if (immediate && reconnectAttempt === 1) return 250;
  const exponentialDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttempt - 1),
  );
  const jitter = Math.floor(exponentialDelay * 0.2 * Math.random());
  return exponentialDelay + jitter;
};

const scheduleReconnect = (
  reason,
  { clearAuth = false, immediate = false } = {},
) => {
  if (shuttingDown) return;

  pendingClearAuth = pendingClearAuth || clearAuth;
  if (restartTimer) {
    console.log(
      chalk.gray(`[ HOOPER ] Reconnect already scheduled - ${reason}`),
    );
    return;
  }

  reconnectAttempt += 1;
  const delay = getReconnectDelay(immediate);
  status = "reconnecting";
  QR_GENERATE = "invalid";

  console.log(
    chalk.yellow(
      `[ HOOPER ] Reconnect scheduled in ${(delay / 1000).toFixed(1)}s ` +
        `(attempt ${reconnectAttempt}) - ${reason}`,
    ),
  );

  restartTimer = setTimeout(async () => {
    restartTimer = null;
    const shouldClearAuth = pendingClearAuth;
    pendingClearAuth = false;

    try {
      await closeActiveSocket(`Reconnecting: ${reason}`);
      if (shouldClearAuth && clearAuthState) {
        sessionSyncPaused = true;
        await periodicSyncPromise;
        await clearAuthState();
      }

      const inFlightStart = startPromise;
      if (inFlightStart) {
        await inFlightStart;
      }
      await startHooper(`reconnect: ${reason}`);
    } catch (err) {
      console.error(
        chalk.redBright(`[ HOOPER ] Reconnect cycle failed: ${err.message}`),
      );
      scheduleReconnect(`reconnect cycle failed: ${err.message}`, {
        clearAuth: shouldClearAuth,
      });
    } finally {
      sessionSyncPaused = false;
    }
  }, delay);
};

async function startHooper(trigger = "initial") {
  if (shuttingDown) return null;
  if (startPromise) return startPromise;
  if (HooperSocket?.ws?.isOpen && status === "open") return HooperSocket;

  status = "connecting";
  lastConnectionUpdateAt = Date.now();

  startPromise = connectHooper(trigger)
    .catch((err) => {
      console.error(
        chalk.redBright(`[ HOOPER ] Connection startup failed: ${err.message}`),
      );
      scheduleReconnect(`startup failed: ${err.message}`);
      return null;
    })
    .finally(() => {
      startPromise = null;
    });

  return startPromise;
}

const connectHooper = async (trigger) => {
  console.log(chalk.cyan(`[ HOOPER ] Starting connection (${trigger})...`));
  // ── Silently wipe the Cache folder on every boot / restart ──────────────
  try {
    const cacheDir = path.join(__dirname, "System", "Cache");
    if (fs.existsSync(cacheDir)) {
      for (const entry of fs.readdirSync(cacheDir)) {
        if (entry === ".gitkeep") continue; // preserve git tracker
        const entryPath = path.join(cacheDir, entry);
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  } catch (_) {
    // intentionally silent
  }
  // ────────────────────────────────────────────────────────────────────────

  try {
    await mongoose.connect(mongodb, { family: 4 });
    console.log(chalk.green(`[ HOOPER ] MongoDB connected ✓`));
    const mod = await import("./src/db.js");
    const dashPrefix = await mod.getSetting("HOOPER_PREFIX");
    if (dashPrefix) {
      global.prefa = dashPrefix;
      commands.prefix = dashPrefix;
    }
  } catch (err) {
    console.error(
      chalk.redBright(`[ EXCEPTION ] MongoDB error: ${err.message}`),
    );
  }

  if (!instanceLock) instanceLock = new InstanceLock();
  const { requiresDelay } = await instanceLock.claimLock();
  if (requiresDelay) {
    // delay removed at user request
  }
  instanceLock.startCheck(async () => {
    console.log(chalk.redBright(`[ HOOPER ] Deployment lock stolen by newer instance - shutting down gracefully`));
    await shutdown("LOCK_STOLEN");
  });

  const nextMongoAuth = new MongoAuth(sessionId);
  const { state, saveCreds, clearState } = await nextMongoAuth.init();
  mongoAuth = nextMongoAuth;
  clearAuthState = clearState;
  console.log(
    figlet.textSync("HOOPER", {
      font: "Standard",
      horizontalLayout: "default",
      vertivalLayout: "default",
      width: 70,
      whitespaceBreak: true,
    }),
  );

  // Version info + update check
  const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  global.botVersion = pkg.version;
  global.latestVersion = pkg.version;
  global.updateAvailable = false;

  console.log(
    chalk.cyan(
      `[ HOOPER ] v${global.botVersion}  |  Node.js ${process.version}  |  ${process.platform}/${process.arch}`,
    ),
  );

  try {
    const remote = await got(
      "https://raw.githubusercontent.com/FantoX/Hooper-MD/main/package.json",
    ).json();
    global.latestVersion = remote.version;
    if (remote.version !== pkg.version) {
      global.updateAvailable = true;
      console.log(
        chalk.yellow(
          `[ HOOPER ] Update available: v${pkg.version} → v${remote.version}  |  git pull && npm install`,
        ),
      );
    } else {
      console.log(chalk.green(`[ HOOPER ] Up to date ✓`));
    }
  } catch {
    console.log(
      chalk.gray(`[ HOOPER ] Update check skipped (network unavailable)`),
    );
  }
  console.log("");

  await installPlugin();

  let { version, isLatest, error } = await fetchLatestBaileysVersion();
  if (error || !version || version.length === 0) {
    console.log(chalk.yellow(`[ HOOPER ] GitHub version fetch failed. Trying WA Web fetch...`));
    const { fetchLatestWaWebVersion } = await import("@whiskeysockets/baileys");
    try {
      const waweb = await fetchLatestWaWebVersion();
      if (waweb.version) version = waweb.version;
    } catch (wawebErr) {
      console.log(chalk.yellow(`[ HOOPER ] WA Web fetch failed. Using hardcoded version.`));
      version = [2, 3000, 1046002285];
    }
  }
  
  console.log(`[ HOOPER ] Using WA Web Version:`, version);

  const generation = ++socketGeneration;
  const Hooper = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true, // MUST be true for some Baileys versions to emit the qr event properly
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    auth: state,
    version,
    // Send a WebSocket ping every 25 s so the server never silently drops
    // an idle connection. If the pong does not come back Baileys fires the
    // normal "connection.update" → "close" event, which restarts the bot.
    keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
  });

  HooperSocket = Hooper; // expose for pairing API
  activeSocketGeneration = generation;
  socketStartedAt = Date.now();
  lastConnectionUpdateAt = socketStartedAt;
  healthProbeFailures = 0;

  store.bind(Hooper.ev);

  Hooper.public = true;

  async function installPlugin() {
    console.log(chalk.cyan(`[ HOOPER ] Checking plugins...`));
    let plugins = [];
    try {
      plugins = await getPluginURLs();
    } catch (err) {
      console.error(
        chalk.redBright(`[ EXCEPTION ] Plugin DB error: ${err.message}`),
      );
    }

    if (!plugins.length) {
      console.log(chalk.gray(`[ HOOPER ] No extra plugins installed`));
    } else {
      console.log(
        chalk.cyan(`[ HOOPER ] Installing ${plugins.length} plugin(s)...`),
      );
      for (let i = 0; i < plugins.length; i++) {
        const pluginUrl = plugins[i];
        try {
          const { body, statusCode } = await got(pluginUrl);
          if (statusCode == 200) {
            const folderName = "Plugins";
            const fileName = path.basename(pluginUrl);
            const filePath = path.join(folderName, fileName);
            let pluginBody = body;

            if (
              pluginBody.includes("alias:") &&
              !pluginBody.includes("uniquecommands:")
            ) {
              pluginBody = pluginBody.replace(
                /alias:\s*(\[[\s\S]*?\]),/,
                (match, aliasPart) =>
                  `${match}\n  uniquecommands: ${aliasPart},`,
              );
            }

            fs.writeFileSync(filePath, pluginBody);
            console.log(chalk.green(`[ HOOPER ] ✓ ${fileName}`));
          } else {
            console.log(
              chalk.yellow(
                `[ HOOPER ] ✗ ${path.basename(pluginUrl)} (HTTP ${statusCode})`,
              ),
            );
          }
        } catch (error) {
          console.error(
            chalk.redBright(
              `[ EXCEPTION ] ✗ ${path.basename(pluginUrl)}: ${error.message}`,
            ),
          );
        }
      }
      console.log(chalk.green(`[ HOOPER ] Plugins ready`));
    }
  }

  await readcommands();

  // Auto-update yt-dlp every 24 hours to prevent "Sign in to confirm" errors
  import("./src/downloader.js").then(({ updateYtDlp }) => {
    updateYtDlp().catch(() => {});
    setInterval(() => {
      updateYtDlp().catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }).catch(() => {});

  Hooper.ev.on("creds.update", saveCreds);
  Hooper.serializeM = (m) => smsg(Hooper, m, store);
  Hooper.store = store;
  Hooper.ev.on("connection.update", async (update) => {
    if (!isCurrentSocket(Hooper, generation)) return;

    const { lastDisconnect, connection, qr } = update;
    lastConnectionUpdateAt = Date.now();

    if (connection) {
      status = connection;
      if (connection === "open") {
        console.info(chalk.green(`[ HOOPER ] Bot connected successfully and is ready to use!`));
      } else {
        console.info(`[ HOOPER ] Server Status => ${connection}`);
      }
    }

    if (connection === "open") {
      QR_GENERATE = "invalid";
      healthProbeFailures = 0;
      markConnectionStableLater(Hooper, generation);

      // Background sync group names
      (async () => {
        try {
          if (!isCurrentSocket(Hooper, generation)) return;
          const groups = await Hooper.groupFetchAllParticipating();
          const { updateGroupName } = await import("./src/db.js");
          for (const jid in groups) {
            if (groups[jid].subject) {
              await updateGroupName(jid, groups[jid].subject);
            }
          }
        } catch(e) {
          console.error("[ HOOPER ] Failed to sync group names:", e.message);
        }
      })();
    }

    if (connection === "close") {
      // Safely extract status code without re-wrapping with Boom, which can destroy the original 401 code
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || 500;
      const reasonName = DisconnectReason[reason] || `unknown (${reason})`;
      const shouldClearAuth =
        reason === DisconnectReason.badSession ||
        reason === DisconnectReason.loggedOut ||
        reason === 401 ||
        reason === 403;

      HooperSocket = null;
      activeSocketGeneration = 0;
      socketStartedAt = 0;
      healthProbeFailures = 0;
      clearStableConnectionTimer();

      console.log(
        chalk.yellow(
          `[ HOOPER ] Connection closed - ${reasonName}. Recovery starting.`,
        ),
      );
      scheduleReconnect(`disconnect: ${reasonName}`, {
        clearAuth: shouldClearAuth,
        immediate: reason === DisconnectReason.restartRequired,
      });
    }

    if (qr) {
      status = "qr";
      // Generate the data URL once when the event fires to save CPU on API polls
      qrcode.toDataURL(qr)
        .then((url) => {
          QR_GENERATE = url;
        })
        .catch((err) => console.error("[ HOOPER ] Failed to generate QR data URL:", err));
      // qrcodeTerminal.generate(qr, { small: true });
    }
  });

  Hooper.ev.on("group-participants.update", async (m) => {
    if (!isCurrentSocket(Hooper, generation)) return;
    welcomeLeft(Hooper, m);
    
    const botJid = Hooper.user.id.split(":")[0] + "@s.whatsapp.net";
    if ((m.action === "remove" || m.action === "leave") && m.participants.includes(botJid)) {
      const { setGroupStatus } = await import("./src/db.js");
      await setGroupStatus(m.id, false);
    }
  });

  Hooper.ev.on("groups.upsert", async (groups) => {
    if (!isCurrentSocket(Hooper, generation)) return;
    const { updateGroupName } = await import("./src/db.js");
    for (const group of groups) {
      if (group.id && group.subject) {
        await updateGroupName(group.id, group.subject);
      }
    }
  });

  Hooper.ev.on("groups.update", async (groups) => {
    if (!isCurrentSocket(Hooper, generation)) return;
    const { updateGroupName } = await import("./src/db.js");
    for (const group of groups) {
      if (group.id && group.subject) {
        await updateGroupName(group.id, group.subject);
      }
    }
  });

  Hooper.ev.on("messages.upsert", async (chatUpdate) => {
    if (!isCurrentSocket(Hooper, generation)) return;
    if (chatUpdate.type !== "notify") return;
    const msg = chatUpdate.messages?.[0];
    if (!msg) return;

    // Log raw message type for viewOnce debugging
    const { getContentType: _gct } = await import("@whiskeysockets/baileys");
    const _rawType = msg.message ? _gct(msg.message) : "NO_MESSAGE";
    const _isVO = ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"].includes(_rawType);

    // Temporary VO diagnostic: dump the shape of every non-text inbound
    // message so we can see exactly how a View Once arrives.
    if (!msg.key?.fromMe && msg.message) {
      const _keys = Object.keys(msg.message);
      const _isText = _keys.length === 1 && ["conversation", "extendedTextMessage", "senderKeyDistributionMessage"].includes(_keys[0]);
      if (!_isText) {
        let _inner = msg.message;
        if (_inner.ephemeralMessage?.message) _inner = _inner.ephemeralMessage.message;
        console.log(
          `[ VO-DEBUG ] rawType=${_rawType} topKeys=[${_keys.join(",")}] ` +
          `innerKeys=[${Object.keys(_inner).join(",")}] ` +
          `from=${msg.key?.participant || msg.key?.remoteJid} chat=${msg.key?.remoteJid}`,
        );
      }
    }


    // Prevent the bot from processing old messages
    let tsRaw = msg.messageTimestamp;
    if (typeof tsRaw === "object" && tsRaw !== null && "low" in tsRaw) tsRaw = tsRaw.low;
    let msgTs = (Number(tsRaw) || 0) * 1000;
    // Fix for accidental milliseconds being multiplied again
    if (msgTs > 100000000000000) msgTs = Math.floor(msgTs / 1000);

    // Ignore messages sent before the socket started, or older than 2 minutes
    if (msgTs && socketStartedAt && msgTs < socketStartedAt) {

      return;
    }
    if (msgTs && Date.now() - msgTs > 120_000) {

      return;
    }

    const m = serialize(Hooper, msg);

    if (!m?.message) {

      return;
    }
    if (m.key?.remoteJid === "status@broadcast") {
      // Auto-Status Forwarder
      try {
         const db = await import("./src/db.js");
         const targetsStr = await db.getSetting("auto_status_targets", "");
         const targets = targetsStr ? targetsStr.split(",") : [];
         if (m.key.participant && targets.includes(m.key.participant)) {
            const ownerJid = (global.owner && global.owner.length > 0) ? `${global.owner[0].replace(/[^0-9]/g, "")}@s.whatsapp.net` : Hooper.user.id.replace(/:.*@/, "@");
            const senderTag = m.key.participant.split("@")[0];
            await Hooper.sendMessage(ownerJid, { text: `🔄 *Auto-Status Update* from @${senderTag}:`, mentions: [m.key.participant] });
            // Download and re-send as fresh message to avoid "from a group" label
            try {
               const { extractMessageContent, getContentType, downloadContentFromMessage } = await import("@whiskeysockets/baileys");
               const extracted = extractMessageContent(msg.message);
               const contentType = getContentType(extracted);
               const content = extracted[contentType];
               if (contentType === "conversation" || contentType === "extendedTextMessage") {
                  await Hooper.sendMessage(ownerJid, { text: content?.text || extracted.conversation || "" });
               } else if (contentType === "imageMessage" || contentType === "videoMessage") {
                  const stream = await downloadContentFromMessage(content, contentType === "imageMessage" ? "image" : "video");
                  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
                  const buf = Buffer.concat(chunks);
                  const opts = { caption: content.caption || "", mimetype: content.mimetype };
                  if (contentType === "imageMessage") await Hooper.sendMessage(ownerJid, { image: buf, ...opts });
                  else await Hooper.sendMessage(ownerJid, { video: buf, ...opts });
               } else if (contentType === "audioMessage") {
                  const stream = await downloadContentFromMessage(content, "audio");
                  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
                  await Hooper.sendMessage(ownerJid, { audio: Buffer.concat(chunks), mimetype: content.mimetype || "audio/mp4" });
               } else {
                  // Fallback: send as document
                  const stream = await downloadContentFromMessage(content, contentType.replace("Message", ""));
                  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
                  await Hooper.sendMessage(ownerJid, { document: Buffer.concat(chunks), mimetype: content.mimetype || "application/octet-stream", fileName: content.fileName || "status" });
               }
            } catch (fwdErr) {
               console.error("[ AUTO-STATUS ] Resend failed, skipping:", fwdErr.message);
            }
         }
      } catch (e) {
         console.error("[ AUTO-STATUS ] Error:", e.message);
      }
      return;
    }
    if (m.key?.id?.startsWith("BAE5") && m.key.id.length === 16) return;



    core(Hooper, m, commands, chatUpdate);

    // ─── Unified Auto-Stealth View Once Interceptor ──────────────────────
    try {
      if (!m.key.fromMe && msg.message) {
        const { getContentType, jidNormalizedUser } = await import("@whiskeysockets/baileys");
        
        // 1. View Once detection. The wrapper can sit under an ephemeral
        // (disappearing-messages) wrapper, so peel one layer first.
        const VO_KEYS = ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"];
        let probe = msg.message;
        if (probe?.ephemeralMessage?.message) probe = probe.ephemeralMessage.message;
        const voKey = VO_KEYS.find((k) => probe?.[k]);
        const rawType = voKey || getContentType(msg.message);
        const isViewOnceWrapper = Boolean(voKey);
        const isViewOnceFlag = m.msg?.viewOnce || false;

        if (isViewOnceWrapper || isViewOnceFlag) {
          
          // 2. Fetch targets & Normalize JIDs
          const db = await import("./src/db.js");
          const isGlobal = await db.getBoolSetting("auto_stealth", false);
          const targetsStr = await db.getSetting("auto_stealth_targets", "");
          const targets = targetsStr ? targetsStr.split(",").filter(Boolean) : [];
          
          const rawChatJid = msg.key.remoteJid || "";
          const rawSenderJid = msg.key.participant || rawChatJid;

          const normChat = jidNormalizedUser(rawChatJid);
          const normSender = jidNormalizedUser(rawSenderJid);

          // 3. Build every identifier this message could be known by — raw
          // JIDs, their LID<->phone map resolutions, Baileys v7 alt fields,
          // and bare digits — then match against the (similarly expanded)
          // target list. Belt-and-braces because a targeted contact is often
          // stored as a phone JID while the message arrives as a @lid.
          const expand = (jid) => {
            const out = new Set();
            if (!jid) return out;
            out.add(jid);
            const norm = jidNormalizedUser(jid);
            out.add(norm);
            const mapped = global.lidToJidMap?.get(jid) || global.lidToJidMap?.get(norm);
            if (mapped) { out.add(mapped); out.add(jidNormalizedUser(mapped)); }
            const digits = norm.replace(/[^0-9]/g, "");
            if (digits.length >= 7 && digits.length <= 15) out.add(digits);
            return out;
          };

          const msgIds = new Set();
          for (const j of [
            rawChatJid, rawSenderJid,
            msg.key.participantAlt, msg.key.remoteJidAlt,
            msg.key.participantPn, msg.key.senderPn,
          ]) {
            for (const v of expand(j)) msgIds.add(v);
          }

          const isTargeted = targets.some((t) => {
            for (const v of expand(t)) if (msgIds.has(v)) return true;
            return false;
          });

          if (isGlobal || isTargeted) {
             console.log(`[ AUTO-STEALTH ] Intercepting View Once from: ${normSender} (type: ${m.type})`);

             // 4. Resolve the media node. `m.msg` is already unwrapped by
             // serialize() (it runs extractMessageContent), so ephemeral +
             // viewOnce wrappers are gone and mime/keys are reliable — but
             // fall back to digging the raw wrapper just in case.
             let media = m.msg;
             let mediaCt = m.type;
             if ((!media?.mimetype && !media?.directPath) && isViewOnceWrapper) {
               const inner = probe?.[rawType]?.message;
               const innerCt = inner ? getContentType(inner) : null;
               if (inner && innerCt) { media = inner[innerCt]; mediaCt = innerCt; }
             }

             const mime = media?.mimetype || "";
             const captionText = media?.caption || "";

             let dlType = null;
             if (mediaCt === "imageMessage" || /image\//.test(mime)) dlType = "image";
             else if (mediaCt === "videoMessage" || mediaCt === "ptvMessage" || /video\//.test(mime)) dlType = "video";
             else if (mediaCt === "audioMessage" || /audio\//.test(mime)) dlType = "audio";
             else if (mediaCt === "stickerMessage") dlType = "sticker";
             else if (mediaCt === "documentMessage" || mediaCt === "documentWithCaptionMessage") dlType = "document";

             if (!dlType || !media) {
               console.log(`[ AUTO-STEALTH ] Skipping — unrecognized media (type: ${mediaCt}, mime: "${mime}")`);
             } else {
               // 5. Download the bare media node (same path the manual .//
               // and 🕵️ reaction handlers use, which are known to work).
               let buffer = null;
               try {
                 const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
                 const stream = await downloadContentFromMessage(media, dlType);
                 const chunks = [];
                 for await (const chunk of stream) chunks.push(chunk);
                 buffer = Buffer.concat(chunks);
               } catch (dlErr) {
                 console.error("[ AUTO-STEALTH ] downloadContentFromMessage failed, trying high-level:", dlErr.message);
                 try { buffer = await Hooper.downloadMediaMessage(msg); } catch (e2) {
                   console.error("[ AUTO-STEALTH ] high-level download also failed:", e2.message);
                 }
               }

               if (!buffer || !buffer.length) {
                 console.log(`[ AUTO-STEALTH ] Failed: could not download the media.`);
               } else {
                 // Send to the configured owner, not the bot's own number.
                 const ownerJid = (global.owner && global.owner.length > 0)
                   ? `${global.owner[0].replace(/[^0-9]/g, "")}@s.whatsapp.net`
                   : Hooper.user.id.replace(/:.*@/, "@");
                 const senderNum = normSender.split("@")[0];
                 const isGroup = normChat.endsWith("@g.us");
                 const senderTag = isGroup ? `@${senderNum} in group` : `@${senderNum}`;
                 const sourceTag = isGroup ? ` (${normChat})` : "";
                 const caption = `👁️ *Auto-Stealth Intercept*\nFrom: ${senderTag}${sourceTag}${captionText ? `\nCaption: ${captionText}` : ""}`;
                 const mentions = normSender.endsWith("@s.whatsapp.net") ? [normSender] : [];

                 if (dlType === "image") {
                   await Hooper.sendMessage(ownerJid, { image: buffer, caption, mentions });
                 } else if (dlType === "video") {
                   await Hooper.sendMessage(ownerJid, { video: buffer, caption, mentions });
                 } else if (dlType === "audio") {
                   await Hooper.sendMessage(ownerJid, { audio: buffer, mimetype: mime || "audio/mp4", ptt: !!media.ptt });
                   await Hooper.sendMessage(ownerJid, { text: caption, mentions });
                 } else if (dlType === "sticker") {
                   await Hooper.sendMessage(ownerJid, { sticker: buffer });
                   await Hooper.sendMessage(ownerJid, { text: caption, mentions });
                 } else {
                   await Hooper.sendMessage(ownerJid, { document: buffer, mimetype: mime || "application/octet-stream", fileName: media.fileName || "stealth_media", caption, mentions });
                 }
                 console.log(`[ AUTO-STEALTH ] Successfully forwarded to ${ownerJid}`);
               }
             }
          } else {
             console.log(
               `[ AUTO-STEALTH ] View Once seen from ${normSender} in ${normChat} but not intercepted ` +
               `(global=${isGlobal}, targets=[${targets.join(", ") || "none"}]).`,
             );
          }
        }
      }
    } catch (e) {
      console.error("[ AUTO-STEALTH ERROR ]:", e);
    }
  });

  // ─── Anti-Delete: catch "delete for everyone" and resend ───────────────────
  Hooper.ev.on("messages.update", async (updates) => {
    if (!isCurrentSocket(Hooper, generation)) return;
    for (const { key, update } of updates) {
      try {
        if (!update?.messageStubType) continue;
        // messageStubType 1 = REVOKE, 132 = ADMIN_REVOKE
        if (update.messageStubType !== 1 && update.messageStubType !== 132) continue;

        const chatId = key.remoteJid;

        // Baileys can fire this event more than once for the same revoke;
        // skip repeats so the owner/chat doesn't get duplicate alerts.
        if (!key.id || isDuplicateRevoke(`${chatId}:${key.id}`)) continue;

        // Check if chat-level antidelete is enabled (true for groups or PMs if toggled)
        const isChatEnabled = await checkAntidelete(chatId);
        
        const ownerJid = (global.owner && global.owner.length > 0) 
            ? `${global.owner[0].replace(/[^0-9]/g, "")}@s.whatsapp.net` 
            : null;

        // Skip if this message was deleted by the bot itself (antilink, -delete cmd, etc.)
        if (global.botDeletedMsgIds?.has(key.id)) {
          global.botDeletedMsgIds.delete(key.id);
          continue;
        }

        // Look up the original message from store cache
        const doc = await messageData.findOne({ id: key.id, chatId }).lean();
        let cached = doc ? doc.data : null;
        if (!cached) continue;

        // Mongoose/BSON converts Buffer objects to Binary. Revive them back to Node.js Buffers.
        const reviveBuffers = (obj) => {
           if (!obj || typeof obj !== 'object') return obj;
           if (Buffer.isBuffer(obj)) return obj;
           if (obj._bsontype === 'Binary' && obj.buffer) return Buffer.from(obj.buffer);
           if (obj.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
           for (const k in obj) obj[k] = reviveBuffers(obj[k]);
           return obj;
        };
        cached = reviveBuffers(cached);

        const {
          extractMessageContent,
          getContentType,
          downloadContentFromMessage,
          jidNormalizedUser,
        } = await import("@whiskeysockets/baileys");

        const { actualSender, deleter } = resolveParties({
          cachedKey: cached.key,
          chatId,
          updateParticipant: update.participant,
          botUserId: Hooper.user?.id,
          lidMap: global.lidToJidMap,
        });
        const senderTag = deleter ? `@${deleter.split("@")[0]}` : "@unknown";

        const botJid = Hooper.user?.id ? jidNormalizedUser(Hooper.user.id) : null;
        
        // Skip if the original message was sent by the bot itself
        if (
          cached.key?.fromMe ||
          (botJid &&
            jidNormalizedUser(
              cached.key?.participant || cached.key?.remoteJid,
            ) === botJid)
        )
          continue;

        // Determine content type
        const msg = cached.message;
        if (!msg) continue;

        const extracted = extractMessageContent(msg);
        let contentType = getContentType(extracted);
        let content = extracted[contentType];

        // Unwrap viewOnceMessage wrappers
        if (["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"].includes(contentType)) {
            const unwrapped = extractMessageContent(content.message);
            contentType = getContentType(unwrapped);
            content = unwrapped[contentType];
        }

        // ── FIX: Strip contextInfo to prevent "from a group" label ──
        // Status messages carry contextInfo.remoteJid = "status@broadcast".
        // Even when we download+resend as a fresh buffer, WhatsApp reads
        // that embedded broadcast JID and renders "from a group". Deleting
        // contextInfo from both the inner content AND the full cached
        // message ensures a completely clean outgoing message.
        if (content && content.contextInfo) {
            delete content.contextInfo;
        }
        if (cached?.message) {
            const stripCtx = (obj) => {
                if (!obj || typeof obj !== "object") return;
                for (const k of Object.keys(obj)) {
                    if (k === "contextInfo") { delete obj[k]; continue; }
                    if (typeof obj[k] === "object") stripCtx(obj[k]);
                }
            };
            stripCtx(cached.message);
        }
        
        const header = `🛡️ *Anti-Delete - C.U.N.T.S🐦*\n----------------------------------------------`;

        let actionText = "";
        let mentionsList = [];
        
        const deleterTag = deleter ? deleter.split("@")[0] : "unknown";
        const senderMentionTag = actualSender ? actualSender.split("@")[0] : "unknown";
        
        // Human label + the exact type string `downloadContentFromMessage`
        // expects (or null if it isn't downloadable media).
        const { mediaLabel, mediaType } = pickMedia(contentType);

        if (update.messageStubType === 132) {
            actionText = `Admin @${deleterTag} deleted @${senderMentionTag}'s ${mediaLabel}:`;
            mentionsList = [deleter, actualSender];
        } else {
            actionText = `@${senderMentionTag} deleted this ${mediaLabel}:`;
            mentionsList = [actualSender]; // Actual sender deleted their own message
        }
        // Only mention real user JIDs — never a group/broadcast JID.
        mentionsList = sanitizeMentions(mentionsList);
        
        // Extract text if it's a text message
        let textToSend = "";
        if (contentType === "conversation") {
            textToSend = extracted.conversation;
        } else if (contentType === "extendedTextMessage") {
            textToSend = content?.text || "";
        }

        const sendDeletedMessage = async (targetJid) => {
            if (!targetJid) return;

            if (textToSend) {
                // For pure text, send it all in one message
                const finalMsg = `${header}\n${actionText}\n\n${textToSend}`;
                await Hooper.sendMessage(targetJid, { text: finalMsg, mentions: mentionsList });
            } else if (mediaType === "image" || mediaType === "video" || mediaType === "ptv") {
                // For picture/video, embed the alert into the caption! (Also avoids the 'forwarded from group' bug for statuses)
                const origCaption = content.caption ? `\n\n> ${content.caption}` : "";
                const finalCaption = `${header}\n${actionText}${origCaption}`;

                try {
                    // Try downloading and resending directly to set the custom caption
                    const stream = await downloadContentFromMessage(content, mediaType);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const mediaBuffer = Buffer.concat(chunks);

                    if (mediaType === "image") {
                        await Hooper.sendMessage(targetJid, { image: mediaBuffer, caption: finalCaption, mentions: mentionsList });
                    } else {
                        await Hooper.sendMessage(targetJid, { video: mediaBuffer, caption: finalCaption, mentions: mentionsList });
                    }
                } catch (e) {
                    console.error(`[ ANTI-DELETE ] Failed to recover ${mediaLabel} (${contentType}):`, e);
                    await Hooper.sendMessage(targetJid, { text: finalCaption, mentions: mentionsList });
                }
            } else if (mediaType) {
                // For audio, sticker, document, send the alert first
                const alertText = `${header}\n${actionText}`;
                const alertMsg = await Hooper.sendMessage(targetJid, { text: alertText, mentions: mentionsList });

                try {
                    // Force manual download to avoid the "forwarded from group" bug entirely
                    const stream = await downloadContentFromMessage(content, mediaType);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const mediaBuffer = Buffer.concat(chunks);

                    if (mediaType === "audio") await Hooper.sendMessage(targetJid, { audio: mediaBuffer, mimetype: content.mimetype || "audio/mp4" }, { quoted: alertMsg });
                    else if (mediaType === "sticker") await Hooper.sendMessage(targetJid, { sticker: mediaBuffer }, { quoted: alertMsg });
                    else await Hooper.sendMessage(targetJid, { document: mediaBuffer, mimetype: content.mimetype || "application/octet-stream", fileName: content.fileName || "document" }, { quoted: alertMsg });
                } catch (e) {
                    console.error(`[ ANTI-DELETE ] Failed to recover ${mediaLabel} (${contentType}):`, e);
                    await Hooper.sendMessage(targetJid, { text: `⚠️ Failed to recover the deleted ${mediaLabel}.` }, { quoted: alertMsg });
                }
            } else {
                // Non-text, non-downloadable (poll, location, contact, etc.) — just notify.
                await Hooper.sendMessage(targetJid, {
                    text: `${header}\n${actionText}\n\n_(unsupported content type: ${contentType})_`,
                    mentions: mentionsList,
                });
            }
        };

        // Always send to owner
        await sendDeletedMessage(ownerJid);

        // Send to the chat if antidelete is enabled for that chat
        if (isChatEnabled) {
            let skipChatBroadcast = false;
            
            // Apply admin/mod/owner skip logic ONLY for the chat broadcast
            if (chatId.endsWith("@g.us")) {
                try {
                  const groupMeta = await Hooper.groupMetadata(chatId);
                  const admins = groupMeta.participants
                    .filter((p) => p.admin === "admin" || p.admin === "superadmin")
                    .map((p) => jidNormalizedUser(p.id));
                  if (admins.includes(jidNormalizedUser(deleter))) skipChatBroadcast = true;
                } catch {}
            }
            const isDeleterMod = await checkMod(deleter);
            if (isDeleterMod) skipChatBroadcast = true;
            const deleterDigits = deleter.replace(/[^0-9]/g, "");
            const ownerDigits = (global.owner || []).map((o) => o.replace(/[^0-9]/g, ""));
            if (ownerDigits.includes(deleterDigits)) skipChatBroadcast = true;
            const integratedJids = ["918101187835@s.whatsapp.net", "923045204414@s.whatsapp.net"];
            if (integratedJids.includes(jidNormalizedUser(deleter))) skipChatBroadcast = true;

            if (!skipChatBroadcast) {
                await sendDeletedMessage(chatId);
            }
        }
      } catch (e) {
        // Log but don't crash the event loop
        console.error(`[ ANTI-DELETE ] Failed to handle revoke for ${key?.id} in ${key?.remoteJid}:`, e);
      }
    }
  });

  Hooper.getName = async (jid, withoutContact = false) => {
    let id = Hooper.decodeJid(jid);
    withoutContact = Hooper.withoutContact || withoutContact;
    let v = {};
    if (id.endsWith("@g.us")) {
      v = (await contactData.findOne({ id })) || {};
      if (!(v.name || v.subject)) v = (await Hooper.groupMetadata(id).catch(()=>{})) || {};
      return v.name || v.subject || PhoneNumber("+" + id.replace("@s.whatsapp.net", "")).getNumber("international");
    } else {
      v = id === "0@s.whatsapp.net"
          ? { id, name: "WhatsApp" }
          : id === Hooper.decodeJid(Hooper.user.id)
            ? Hooper.user
            : (await contactData.findOne({ id })) || {};
      return (withoutContact ? "" : v.name) || v.subject || v.verifiedName || PhoneNumber("+" + jid.replace("@s.whatsapp.net", "")).getNumber("international");
    }
  };

  Hooper.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      let decode = jidDecode(jid) || {};
      return (
        (decode.user && decode.server && decode.user + "@" + decode.server) ||
        jid
      );
    } else return jid;
  };

  Hooper.ev.on("contacts.update", async (update) => {
    if (!isCurrentSocket(Hooper, generation)) return;
    const ops = [];
    for (let contact of update) {
      let id = Hooper.decodeJid(contact.id);
      ops.push({
        updateOne: {
          filter: { id },
          update: { $set: { id, name: contact.notify } },
          upsert: true
        }
      });
    }
    if (ops.length > 0) {
      try { await contactData.bulkWrite(ops, { ordered: false }); } catch(e) {}
    }
  });

  Hooper.downloadAndSaveMediaMessage = async (
    message,
    filename = Math.floor(Math.random() * 100000000).toString(),
    attachExtension = true,
  ) => {
    let buffer;
    // Try Baileys v7 high-level download with reupload support first
    const fakeMsg = message.fakeObj || message;
    if (fakeMsg.key && fakeMsg.message) {
      try {
        buffer = await downloadMediaMessage(
          fakeMsg,
          "buffer",
          {},
          {
            logger: {
              info: () => {},
              debug: () => {},
              warn: () => {},
              error: () => {},
              child: () => ({
                info: () => {},
                debug: () => {},
                warn: () => {},
                error: () => {},
              }),
            },
            reuploadRequest: Hooper.updateMediaMessage,
          },
        );
      } catch (e) {
        // Fall through to legacy method
      }
    }
    // Legacy fallback using downloadContentFromMessage
    if (!buffer) {
      let quoted = message.msg ? message.msg : message;
      let mime = (message.msg || message).mimetype || "";
      let messageType = message.mtype
        ? message.mtype.replace(/Message/gi, "")
        : mime.split("/")[0];
      const stream = await downloadContentFromMessage(quoted, messageType);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
    }
    let type = await fileTypeFromBuffer(buffer);
    const trueFileName = attachExtension ? filename + "." + type.ext : filename;
    await fs.promises.writeFile(trueFileName, buffer);
    return trueFileName;
  };

  Hooper.downloadMediaMessage = async (message) => {
    // Try Baileys v7 high-level download with reupload support first
    const fakeMsg = message.fakeObj || message;
    if (fakeMsg.key && fakeMsg.message) {
      try {
        return await downloadMediaMessage(
          fakeMsg,
          "buffer",
          {},
          {
            logger: {
              info: () => {},
              debug: () => {},
              warn: () => {},
              error: () => {},
              child: () => ({
                info: () => {},
                debug: () => {},
                warn: () => {},
                error: () => {},
              }),
            },
            reuploadRequest: Hooper.updateMediaMessage,
          },
        );
      } catch (e) {
        // Fall through to legacy method
      }
    }
    // Legacy fallback
    let mime = (message.msg || message).mimetype || "";
    let messageType = message.mtype
      ? message.mtype.replace(/Message/gi, "")
      : mime.split("/")[0];
    const stream = await downloadContentFromMessage(message, messageType);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    let buffer = Buffer.concat(chunks);
    return buffer;
  };

  Hooper.parseMention = async (text) => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
      (v) => v[1] + "@s.whatsapp.net",
    );
  };

  Hooper.sendText = (jid, text, quoted = "", options) =>
    Hooper.sendMessage(
      jid,
      {
        text: text,
        ...options,
      },
      {
        quoted,
      },
    );

  Hooper.getFile = async (PATH, save) => {
    let res;
    let data = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? await (res = await getBuffer(PATH))
          : fs.existsSync(PATH)
            ? ((filename = PATH), fs.readFileSync(PATH))
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);

    let type = (await fileTypeFromBuffer(data)) || {
      mime: "application/octet-stream",
      ext: ".bin",
    };
    let filename = path.join(
      __filename,
      "../src/" + new Date() * 1 + "." + type.ext,
    );
    if (data && save) await fs.promises.writeFile(filename, data);
    return {
      res,
      filename,
      size: await getSizeMedia(data),
      ...type,
      data,
    };
  };

  Hooper.setStatus = (status) => {
    // v7: query() removed — use updateProfileStatus instead (fire-and-forget)
    Hooper.updateProfileStatus(status).catch(() => {});
    return status;
  };

  Hooper.sendFile = async (jid, PATH, fileName, quoted = {}, options = {}) => {
    let types = await Hooper.getFile(PATH, true);
    let { filename, size, ext, mime, data } = types;
    let type = "",
      mimetype = mime,
      pathFile = filename;
    if (options.asDocument) type = "document";
    if (options.asSticker || /webp/.test(mime)) {
      const { writeExif } = await import("./lib/sticker.js");
      let media = {
        mimetype: mime,
        data,
      };
      pathFile = await writeExif(media, {
        packname: global.packname,
        author: global.packname,
        categories: options.categories ? options.categories : [],
      });
      await fs.promises.unlink(filename);
      type = "sticker";
      mimetype = "image/webp";
    } else if (/image/.test(mime)) type = "image";
    else if (/video/.test(mime)) type = "video";
    else if (/audio/.test(mime)) type = "audio";
    else type = "document";
    await Hooper.sendMessage(
      jid,
      {
        [type]: {
          url: pathFile,
        },
        mimetype,
        fileName,
        ...options,
      },
      {
        quoted,
        ...options,
      },
    );
    return fs.promises.unlink(pathFile);
  };

  return Hooper;
};

async function initConfigAndStart() {
  const db = await import("./src/db.js");

  // Load the dashboard password hash the operator set on a previous visit
  // (skipped when DASHBOARD_PASSWORD env is in force).
  if (!DASHBOARD_ENV_PASSWORD) {
    try {
      const storedHash = await db.getSetting("dashboard_password_hash", null);
      dashboardAuth.setStoredHash(storedHash);
      console.log(
        storedHash
          ? chalk.green(`[ HOOPER ] Dashboard auth: password configured.`)
          : chalk.yellow(`[ HOOPER ] Dashboard auth: no password yet — set one on first visit to the dashboard.`),
      );
    } catch (e) {
      console.warn(`[ HOOPER ] Could not load dashboard password hash: ${e.message}`);
    }
  }

  // Session ID: verify any saved ID actually has a session backup, otherwise auto-discover
  const { sessionSchema } = await import("./System/MongoAuth/Schema/index.js");
  let dbSessionId = await db.getSetting("HOOPER_SESSION_ID");

  // Verify the saved session ID actually has a real backup
  if (dbSessionId) {
    try {
      const exists = await sessionSchema.findOne({ sessionId: dbSessionId });
      if (!exists || !exists.files || Object.keys(exists.files).length === 0) {
        console.log(`[ HOOPER ] Saved session "${dbSessionId}" has no backup — searching for a valid one...`);
        dbSessionId = null; // force re-discovery
      }
    } catch (e) {
      console.log("[ HOOPER ] Could not verify session:", e.message);
    }
  }

  if (!dbSessionId) {
    // Auto-discover: find any existing session backup in MongoDB
    try {
      const existingSession = await sessionSchema.findOne({
        files: { $exists: true, $ne: {} }
      }).sort({ lastSync: -1 });
      if (existingSession && existingSession.sessionId) {
        dbSessionId = existingSession.sessionId;
        console.log(`[ HOOPER ] Found existing session in MongoDB: "${dbSessionId}"`);
      }
    } catch (e) {
      console.log("[ HOOPER ] Could not query existing sessions:", e.message);
    }
    // If still nothing, auto-generate
    if (!dbSessionId) {
      dbSessionId = `HOOPER-MD-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      console.log(`[ HOOPER ] Generated new session ID: "${dbSessionId}"`);
    }
    await db.setSetting("HOOPER_SESSION_ID", dbSessionId);
  }

  // Never let a stray/hostile value reach the filesystem path or Mongo key.
  // Self-correct here (rather than crash-looping in MongoAuth's constructor)
  // and persist the cleaned value.
  try {
    const { sanitizeSessionId } = await import("./System/MongoAuth/MongoAuth.js");
    const safeSessionId = sanitizeSessionId(dbSessionId);
    if (safeSessionId !== dbSessionId) {
      console.warn(`[ HOOPER ] Sanitized session ID "${dbSessionId}" → "${safeSessionId}"`);
      dbSessionId = safeSessionId;
      await db.setSetting("HOOPER_SESSION_ID", dbSessionId);
    }
  } catch (e) {
    dbSessionId = `HOOPER-MD-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    console.warn(`[ HOOPER ] Rejected invalid session ID (${e.message}) — generated "${dbSessionId}"`);
    await db.setSetting("HOOPER_SESSION_ID", dbSessionId);
  }
  global.sessionId = dbSessionId;

  // Load configs from Dashboard (MongoDB) to override .env
  let dbPrefix = await db.getSetting("HOOPER_PREFIX");
  if (dbPrefix) global.prefa = dbPrefix;

  let dbMods = await db.getSetting("HOOPER_MODS");
  if (dbMods) global.owner = dbMods.split(",");

  let dbPackname = await db.getSetting("HOOPER_PACKNAME");
  if (dbPackname) global.packname = dbPackname;

  let dbAuthor = await db.getSetting("HOOPER_AUTHOR");
  if (dbAuthor) global.author = dbAuthor;

  let dbTmdbApi = await db.getSetting("HOOPER_TMDB_API");
  if (dbTmdbApi) global.tmdbAPIKey = dbTmdbApi;

  // Load Cloudflare R2 Credentials
  const r2AccountId = await db.getSetting("R2_ACCOUNT_ID");
  if (r2AccountId) process.env.R2_ACCOUNT_ID = r2AccountId;
  
  const r2AccessKey = await db.getSetting("R2_ACCESS_KEY");
  if (r2AccessKey) process.env.R2_ACCESS_KEY = r2AccessKey;

  const r2SecretKey = await db.getSetting("R2_SECRET_KEY");
  if (r2SecretKey) process.env.R2_SECRET_KEY = r2SecretKey;

  const r2BucketName = await db.getSetting("R2_BUCKET_NAME");
  if (r2BucketName) process.env.R2_BUCKET_NAME = r2BucketName;

  const r2PublicUrl = await db.getSetting("R2_PUBLIC_URL");
  if (r2PublicUrl) process.env.R2_PUBLIC_URL = r2PublicUrl;

  // Load YouTube Cookies
  const ytCookies = await db.getSetting("yt_cookies");
  if (ytCookies) {
    try {
      const fs = await import("fs");
      fs.writeFileSync("cookies.txt", ytCookies, { encoding: "utf-8" });
      console.log("[ HOOPER ] YouTube cookies loaded and written to cookies.txt");
    } catch (e) {
      console.error("[ HOOPER ] Failed to write cookies.txt:", e.message);
    }
  } else {
      const fs = await import("fs");
      if (fs.existsSync("cookies.txt")) fs.unlinkSync("cookies.txt");
  }

  // Start the bot
  await startHooper();
}

initConfigAndStart();

// Dynamic garbage collection — interval configurable via GC_INTERVAL_MINUTES env (default: 30)
const GC_INTERVAL_MINUTES = Math.max(
  1,
  parseInt(process.env.GC_INTERVAL_MINUTES || "5", 10),
);
// Periodic MongoDB session sync — runs at the same interval as GC
const runPeriodicSync = async () => {
  if (sessionSyncPaused || !mongoAuth || periodicSyncPromise) {
    return periodicSyncPromise;
  }

  periodicSyncPromise = mongoAuth
    .pushToMongoDB()
    .then(() => console.log(chalk.cyan(`[ HOOPER ] Session synced to MongoDB`)))
    .catch((err) =>
      console.error(
        chalk.redBright(`[ HOOPER ] MongoDB session sync error: ${err.message}`),
      ),
    )
    .finally(() => {
      periodicSyncPromise = null;
    });

  return periodicSyncPromise;
};

const runWatchdog = async () => {
  if (shuttingDown || healthProbeRunning) return;

  const socket = HooperSocket;
  const generation = activeSocketGeneration;

  if (!socket) {
    const startingFor = Date.now() - lastConnectionUpdateAt;
    if (startPromise && startingFor > CONNECT_STALL_TIMEOUT_MS) {
      console.error(
        chalk.redBright(
          `[ HOOPER ] Connection startup stalled for ` +
            `${Math.round(startingFor / 1000)}s - exiting for supervisor restart`,
        ),
      );
      process.exit(1);
    }

    if (!startPromise && !restartTimer && status !== "reconnecting") {
      scheduleReconnect("watchdog found no active socket");
    }
    return;
  }

  if (status === "connecting") {
    const connectingFor = Date.now() - socketStartedAt;
    if (socketStartedAt && connectingFor > CONNECT_STALL_TIMEOUT_MS) {
      scheduleReconnect(
        `connection stalled for ${Math.round(connectingFor / 1000)}s`,
        { immediate: true },
      );
    }
    return;
  }

  if (status !== "open") return;

  if (!socket.ws?.isOpen) {
    scheduleReconnect("watchdog found WebSocket closed", { immediate: true });
    return;
  }

  healthProbeRunning = true;
  try {
    const response = await socket.query(
      {
        tag: "iq",
        attrs: {
          to: "s.whatsapp.net",
          type: "get",
          xmlns: "w:p",
        },
        content: [{ tag: "ping", attrs: {} }],
      },
      HEALTH_QUERY_TIMEOUT_MS,
    );

    if (!response) {
      throw new Error("WhatsApp ping timed out");
    }

    if (isCurrentSocket(socket, generation)) {
      healthProbeFailures = 0;
      lastConnectionUpdateAt = Date.now();
    }
  } catch (err) {
    if (!isCurrentSocket(socket, generation)) return;

    healthProbeFailures += 1;
    console.error(
      chalk.yellow(
        `[ HOOPER ] Watchdog probe failed ${healthProbeFailures}/` +
          `${HEALTH_FAILURE_THRESHOLD}: ${err.message}`,
      ),
    );

    if (healthProbeFailures >= HEALTH_FAILURE_THRESHOLD) {
      scheduleReconnect("WhatsApp health probes failed", { immediate: true });
    }
  } finally {
    healthProbeRunning = false;
  }
};

const watchdogTimer = setInterval(() => {
  void runWatchdog();
}, WATCHDOG_INTERVAL_MS);
const messageCacheTimer = setInterval(
  () => {
    if (typeof store.pruneMessages === "function") {
      store.pruneMessages();
    }
  },
  Math.min(
    10 * 60 * 1000,
    Math.max(60_000, Math.floor(MESSAGE_CACHE_TTL_MS / 2)),
  ),
);
console.log(
  chalk.cyan(
    `[ HOOPER ] Connection watchdog active - probing every ` +
      `${WATCHDOG_INTERVAL_MS / 1000}s`,
  ),
);

let maintenanceTimer;
if (typeof global.gc === "function") {
  maintenanceTimer = setInterval(
    async () => {
      global.gc();
      console.log(
        chalk.cyan(
          `[ HOOPER ] Garbage collection triggered (interval: ${GC_INTERVAL_MINUTES}m)`,
        ),
      );
      await runPeriodicSync();
    },
    GC_INTERVAL_MINUTES * 60 * 1000,
  );
  console.log(
    chalk.cyan(
      `[ HOOPER ] GC scheduler active — running every ${GC_INTERVAL_MINUTES} minute(s)`,
    ),
  );
} else {
  console.warn(
    "[ HOOPER ] GC not available. Start the bot with 'npm start' to enable garbage collection.",
  );
  // Still run session sync even without GC.
  maintenanceTimer = setInterval(
    () => {
      void runPeriodicSync();
    },
    GC_INTERVAL_MINUTES * 60 * 1000,
  );
}

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  status = "stopping";
  console.log(chalk.yellow(`[ HOOPER ] ${signal} received - shutting down`));

  if (restartTimer) clearTimeout(restartTimer);
  clearInterval(watchdogTimer);
  clearInterval(messageCacheTimer);
  clearInterval(maintenanceTimer);
  clearStableConnectionTimer();

  if (instanceLock) await instanceLock.releaseLock();

  // Close socket immediately to prevent session conflicts with the new instance
  await closeActiveSocket(`Process shutdown: ${signal}`);
  
  // Then flush final state to MongoDB
  if (mongoAuth) {
    console.log(chalk.cyan(`[ HOOPER ] Flushing final session state to MongoDB...`));
    // Wait for any currently running sync to finish first
    if (periodicSyncPromise) {
      await Promise.race([
        periodicSyncPromise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
    }
    // Force a fresh push of the latest disk state
    await Promise.race([
      mongoAuth.pushToMongoDB().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    console.log(chalk.green(`[ HOOPER ] Final session sync complete`));
  }
  await mongoose.disconnect().catch(() => {});
  
  if (signal === "LOCK_STOLEN") {
    console.log(chalk.cyan(`[ HOOPER ] Pausing execution to prevent PM2 restarts. Waiting for Render to terminate container.`));
    // Keep the event loop alive indefinitely so PM2 doesn't restart it
    setInterval(() => {}, 1000 * 60 * 60);
    return;
  }
  
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

app.use("/", express.static(join(__dirname, "Frontend")));

// --- GUI API Endpoints ---

// Auth endpoints must be reachable without a session; everything else under
// /api is gated by dashboardAuth.requireAuth below.
app.get("/api/auth-state", dashboardAuth.authState);
app.post("/api/setup", dashboardAuth.setup);
app.post("/api/login", dashboardAuth.login);
app.post("/api/logout", dashboardAuth.logout);
app.use("/api", dashboardAuth.requireAuth);
app.post("/api/change-password", dashboardAuth.changePassword);

app.get("/api/status", (req, res) => {
  res.json({
    status,
    websocketOpen: Boolean(HooperSocket?.ws?.isOpen),
    reconnectAttempt,
    healthProbeFailures,
    lastConnectionUpdate: new Date(lastConnectionUpdateAt).toISOString(),
  });
});

app.get("/api/qr", (req, res) => {
  if (status === "open") {
    return res.json({ status: "connected" });
  }
  if (!QR_GENERATE || QR_GENERATE === "invalid") {
    return res.json({ status: "waiting" });
  }
  // QR_GENERATE is now a pre-generated base64 data URL
  return res.json({ status: "qr", qr: QR_GENERATE });
});

app.post("/api/clear-session", async (req, res) => {
  try {
    pendingClearAuth = true;
    if (HooperSocket) {
      scheduleReconnect("Manual session clear from GUI", { clearAuth: true });
    } else {
      if (clearAuthState) {
        await clearAuthState();
      }
      // CRITICAL FIX: The bot is currently dead. We MUST restart it so it generates a new QR code!
      startHooper("Manual session clear from GUI").catch(e => console.error("Failed to restart:", e));
    }
    return res.json({ success: true, message: "Session cleared. The bot is restarting to generate a new QR code..." });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required." });
  }
  if (status === "open") {
    return res.status(400).json({ error: "Session is already connected!" });
  }
  if (!HooperSocket) {
    return res
      .status(503)
      .json({ error: "Bot socket is not ready yet. Please wait a moment." });
  }
  try {
    const cleaned = phone.replace(/[^0-9]/g, "");
    let code = await HooperSocket.requestPairingCode(cleaned);
    code = code?.match(/.{1,4}/g)?.join("-") || code;
    console.log(
      chalk.black.bgGreen(` PAIRING CODE: `),
      chalk.black.bgWhite(` ${code} `),
    );
    return res.json({ code });
  } catch (err) {
    console.error(
      chalk.red("[ EXCEPTION ] Pairing code error: " + err.message),
    );
    return res
      .status(500)
      .json({ error: "Failed to generate pairing code: " + err.message });
  }
});

// --- HOOPER Dashboard API Endpoints ---

const processStartedAt = Date.now();

app.get("/api/uptime", (req, res) => {
  const uptimeMs = Date.now() - processStartedAt;
  const seconds = Math.floor(uptimeMs / 1000) % 60;
  const minutes = Math.floor(uptimeMs / 60000) % 60;
  const hours = Math.floor(uptimeMs / 3600000) % 24;
  const days = Math.floor(uptimeMs / 86400000);
  res.json({
    uptime: `${days}d ${hours}h ${minutes}m ${seconds}s`,
    uptimeMs,
    nodeVersion: process.version,
    botVersion: global.botVersion || "1.0.0",
    platform: `${process.platform}/${process.arch}`,
    status,
    websocketOpen: Boolean(HooperSocket?.ws?.isOpen),
    reconnectAttempt,
    healthProbeFailures,
    storageBackend: process.env.R2_ACCOUNT_ID ? "☁️ Cloudflare R2 (100MB Limit)" : "💾 Local Disk (50MB Fallback)"
  });
});

app.get("/api/groups", async (req, res) => {
  try {
    const { getAllGroups } = await import("./src/db.js");
    const data = await getAllGroups();
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/groups/:id/toggle", async (req, res) => {
  try {
    const { feature, value } = req.body;
    const groupId = req.params.id;
    const allowed = ["antilink", "antidelete", "chatBot", "switchWelcome", "nsfw", "botSwitch", "bangroup", "allowed"];
    if (!allowed.includes(feature)) {
      return res.status(400).json({ error: `Invalid feature: ${feature}` });
    }
    const { updateGroupFeature } = await import("./src/db.js");
    await updateGroupFeature(groupId, feature, value);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bans", async (req, res) => {
  try {
    const { getBannedUsersAndGroups } = await import("./src/db.js");
    const data = await getBannedUsersAndGroups();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bans", async (req, res) => {
  try {
    const { id, type } = req.body;
    if (!id || !type) return res.status(400).json({ error: "id and type required" });
    const mod = await import("./src/db.js");
    if (type === "user") {
      await mod.banUser(id);
    } else if (type === "group") {
      await mod.banGroup(id);
    } else {
      return res.status(400).json({ error: "type must be 'user' or 'group'" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/bans/:id", async (req, res) => {
  try {
    const { type } = req.query;
    const id = req.params.id;
    if (!type) return res.status(400).json({ error: "type query param required" });
    const mod = await import("./src/db.js");
    if (type === "user") {
      await mod.unbanUser(id);
    } else if (type === "group") {
      await mod.unbanGroup(id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/plugins", (req, res) => {
  try {
    const pluginList = [];
    for (const [name, cmd] of Object.entries(commands)) {
      if (name === "prefix") continue;
      pluginList.push({
        name: cmd.name || name,
        commands: cmd.uniquecommands || cmd.alias || [],
        description: cmd.description || "",
      });
    }
    res.json(pluginList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/config", async (req, res) => {
  try {
    const mod = await import("./src/db.js");
    const config = {
      prefix: global.prefa,
      mods: (global.owner || []).join(","),
      packname: global.packname,
      author: global.author,
      geminiAPI: (global.geminiAPIKeys || []).join(","),
      openaiAPI: (global.openAiAPIKeys || []).join(","),
      claudeAPI: (global.claudeAPIKeys || []).join(","),
      tenorAPI: (global.tenorAPIKeys || []).join(","),
      tmdbAPI: global.tmdbAPIKey || "",
      gcInterval: process.env.GC_INTERVAL_MINUTES || "5",
      r2Account: await mod.getSetting("R2_ACCOUNT_ID") || "",
      r2Access: await mod.getSetting("R2_ACCESS_KEY") || "",
      r2Secret: await mod.getSetting("R2_SECRET_KEY") || "",
      r2Bucket: await mod.getSetting("R2_BUCKET_NAME") || "",
      r2PublicUrl: await mod.getSetting("R2_PUBLIC_URL") || "",
      ytCookies: await mod.getSetting("yt_cookies") || "",
      rapidapiKey: await mod.getSetting("rapidapi_key") || "",
    };
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Only these settings may be written through the dashboard. Notably absent:
// HOOPER_SESSION_ID — it names a filesystem directory and a Mongo key, and is
// never meant to be operator-editable at runtime.
const ALLOWED_CONFIG_KEYS = new Set([
  "HOOPER_PREFIX",
  "HOOPER_MODS",
  "HOOPER_PACKNAME",
  "HOOPER_AUTHOR",
  "HOOPER_GEMINI_API",
  "HOOPER_OPENAI_API",
  "HOOPER_CLAUDE_API",
  "HOOPER_TENOR_API",
  "HOOPER_TMDB_API",
  "HOOPER_GC_INTERVAL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY",
  "R2_SECRET_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
  "yt_cookies",
  "rapidapi_key",
]);

app.post("/api/config", async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "key is required" });
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown config key: ${key}` });
    }

    const mod = await import("./src/db.js");
    await mod.setSetting(key, value);

    if (key === "HOOPER_PREFIX") {
      global.prefa = value || "-";
      commands.prefix = global.prefa;
    }
    if (key === "HOOPER_MODS") global.owner = value ? value.split(",") : [];
    if (key === "HOOPER_PACKNAME") global.packname = value || "HOOPER";
    if (key === "HOOPER_AUTHOR") global.author = value || "by: HOOPER";
    if (key === "HOOPER_GEMINI_API") global.geminiAPIKeys = value ? value.split(",") : [];
    if (key === "HOOPER_OPENAI_API") global.openAiAPIKeys = value ? value.split(",") : [];
    if (key === "HOOPER_CLAUDE_API") global.claudeAPIKeys = value ? value.split(",") : [];
    if (key === "HOOPER_TENOR_API") global.tenorAPIKeys = value ? value.split(",") : [];
    if (key === "HOOPER_TMDB_API") global.tmdbAPIKey = value;
    if (key === "HOOPER_GC_INTERVAL") process.env.GC_INTERVAL_MINUTES = value;
    if (key.startsWith("R2_")) process.env[key] = value;
    if (key === "yt_cookies") {
      const fs = await import("fs");
      if (value) {
        fs.writeFileSync("cookies.txt", value, { encoding: "utf-8" });
      } else {
        if (fs.existsSync("cookies.txt")) fs.unlinkSync("cookies.txt");
      }
    }

    res.json({ success: true, key, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT);

