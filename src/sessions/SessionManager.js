import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import NodeCache from "node-cache";
import { Mutex } from "async-mutex";
import { useRedisAuthState } from "../redis/useRedisAuthState.js";
import { redisClient } from "../redis/redisClient.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" }).child({ module: "SessionManager" });

class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> { sock, qr, status, retries }
    this.msgRetryCounterCache = new NodeCache({ stdTTL: 3600, useClones: false });
    this.creationMutexes = new Map();
  }

  async createSession(sessionId) {
    if (!this.creationMutexes.has(sessionId)) {
      this.creationMutexes.set(sessionId, new Mutex());
    }
    const mutex = this.creationMutexes.get(sessionId);

    const release = await mutex.acquire();
    try {
      if (this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId);
        if (session.status !== "disconnected") {
           logger.info({ sessionId }, "Session already exists and is active");
           return session;
        } else {
           logger.info({ sessionId }, "Cleaning up disconnected socket before replacing");
           try { session.sock.ev.removeAllListeners(); } catch {}
           try { session.sock.ws?.close(); } catch {}
        }
      }

      logger.info({ sessionId }, "Initializing new session");

      // Setup redis state
      const { state, saveCreds, clearState } = await useRedisAuthState(sessionId, redisClient);

      // Sync meta info to Redis
      redisClient.set(`whatsapp:session:${sessionId}:meta`, JSON.stringify({ created: Date.now() })).catch(() => {});

    // Ensure keys are cached to reduce Redis reads and prevent Signal issues
    const auth = {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger.child({ level: "error" })),
    };

    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ sessionId, version: version.join("."), isLatest }, "Fetched Baileys version");

    const sock = makeWASocket({
      version,
      logger: logger.child({ level: "silent" }),
      printQRInTerminal: false,
      auth,
      browser: ["Koyeb", "Chrome", "111.0.0.0"],
      msgRetryCounterCache: this.msgRetryCounterCache,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      connectTimeoutMs: 120_000,
      keepAliveIntervalMs: 25_000,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 2_000,
      getMessage: async () => ({ conversation: "" }),
    });

    const sessionData = {
      sock,
      qr: null,
      status: "starting",
      retries: 0,
      lastConnect: 0,
    };

    this.sessions.set(sessionId, sessionData);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionData.qr = qr;
        sessionData.status = "qr_required";
        logger.info({ sessionId }, "QR Code generated");
      }

      if (connection === "connecting") {
        sessionData.status = "connecting";
      }

      if (connection === "open") {
        sessionData.status = "connected";
        sessionData.qr = null;
        sessionData.retries = 0;
        sessionData.lastConnect = Date.now();
        logger.info({ sessionId }, "Session connected");

        // Sync health/retry state
        redisClient.set(`whatsapp:session:${sessionId}:health`, "connected").catch(() => {});
        redisClient.set(`whatsapp:session:${sessionId}:retry`, "0").catch(() => {});
      }

      if (connection === "close") {
        sessionData.status = "disconnected";
        const error = lastDisconnect?.error;
        const statusCode = error instanceof Boom ? error.output.statusCode : error?.output?.statusCode;
        const reason = Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0] ?? "Unknown";

        logger.warn({ sessionId, statusCode, reason }, "Connection closed");

        if (statusCode === DisconnectReason.loggedOut) {
          logger.error({ sessionId }, "Logged out. Wiping session.");
          await clearState();
          this.deleteSession(sessionId);
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
            logger.warn({ sessionId }, "Connection replaced. Will not automatically reconnect.");
            return;
        }

        this.handleReconnect(sessionId);
      }
    });

      return sessionData;
    } finally {
      release();
      if (this.creationMutexes.has(sessionId) && !this.creationMutexes.get(sessionId).isLocked()) {
        this.creationMutexes.delete(sessionId);
      }
    }
  }

  handleReconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.retries >= 5) {
      logger.error({ sessionId }, "Max retries reached. Stopping reconnect attempts.");
      return;
    }

    session.retries++;
    redisClient.set(`whatsapp:session:${sessionId}:retry`, session.retries.toString()).catch(() => {});

    const delay = Math.min(2000 * Math.pow(2, session.retries) + Math.random() * 1000, 60000);

    logger.info({ sessionId, retries: session.retries, delay }, "Scheduling reconnect");

    setTimeout(() => {
      if (this.sessions.has(sessionId)) {
        this.createSession(sessionId).catch(err => {
            logger.error({ sessionId, err: err.message }, "Reconnect failed");
        });
      }
    }, delay);
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      try { session.sock.ev.removeAllListeners(); } catch {}
      try { session.sock.ws?.close(); } catch {}
      this.sessions.delete(sessionId);
    }
    const { clearState } = await useRedisAuthState(sessionId, redisClient);
    await clearState();
    logger.info({ sessionId }, "Session deleted");
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      status: data.status
    }));
  }
}

export const sessionManager = new SessionManager();
