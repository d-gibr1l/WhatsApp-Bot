import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import { useRedisAuthState, clearSessionAuth } from '../redis/authState.js';
import { redisClient } from '../redis/client.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { dispatchWebhook } from '../services/webhook.js';

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.reconnectTimeouts = new Map();
  }

  async createSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      logger.warn({ sessionId }, 'Session already exists');
      return this.sessions.get(sessionId);
    }

    // Set lock to prevent duplicate initialization
    const lockKey = `whatsapp:session:${sessionId}:lock`;
    const acquired = await redisClient.set(lockKey, '1', 'NX', 'EX', 10);
    if (!acquired) {
      logger.warn({ sessionId }, 'Session initialization locked by another process');
      throw new Error('Session initialization locked');
    }

    try {
      const { state, saveCreds } = await useRedisAuthState(sessionId);

      const sessionSignalCache = new NodeCache();
      const sessionMsgRetryCache = new NodeCache();

      const socket = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: 'baileys-cache' }), sessionSignalCache),
        },
        logger: logger.child({ module: 'baileys' }),
        printQRInTerminal: false,
        msgRetryCounterCache: sessionMsgRetryCache,
        browser: ['KoyebBot', 'Chrome', '1.0.0'],
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
      });

      this.sessions.set(sessionId, {
        socket,
        status: 'connecting',
        qr: null,
      });

      socket.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err) {
          logger.error({ sessionId, err }, 'Failed to save credentials');
        }
      });

      socket.ev.on('connection.update', async (update) => {
        await this.handleConnectionUpdate(sessionId, update);
      });

      // Basic event dispatching
      socket.ev.on('messages.upsert', (m) => {
        dispatchWebhook(sessionId, 'messages.upsert', m);
      });

      await redisClient.set(`whatsapp:session:${sessionId}:meta`, JSON.stringify({ createdAt: Date.now() }));
      await redisClient.del(lockKey);

      return this.sessions.get(sessionId);
    } catch (err) {
      await redisClient.del(lockKey);
      logger.error({ sessionId, err }, 'Failed to create session');
      throw err;
    }
  }

  async handleConnectionUpdate(sessionId, update) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      session.status = 'qr_required';
      logger.info({ sessionId }, 'QR code required');
      dispatchWebhook(sessionId, 'qr', { qr });
    }

    if (connection === 'close') {
      session.status = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.info({ sessionId, statusCode, shouldReconnect }, 'Connection closed');
      dispatchWebhook(sessionId, 'connection', { status: 'disconnected', reason: statusCode });

      if (shouldReconnect) {
        this.reconnectSession(sessionId);
      } else {
        logger.info({ sessionId, statusCode }, 'Session logged out. Not deleting auth state automatically as requested.');
        if (session.socket) {
          session.socket.ws?.close();
        }
        // Do not call this.deleteSession(sessionId) so state remains in Redis and memory
      }
    } else if (connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      logger.info({ sessionId }, 'Connection opened');
      dispatchWebhook(sessionId, 'connection', { status: 'connected' });

      // Reset reconnect retry count
      await redisClient.del(`whatsapp:session:${sessionId}:retry`);
    }
  }

  async reconnectSession(sessionId) {
    if (this.reconnectTimeouts.has(sessionId)) {
      clearTimeout(this.reconnectTimeouts.get(sessionId));
    }

    const retryKey = `whatsapp:session:${sessionId}:retry`;
    const retries = parseInt(await redisClient.get(retryKey) || '0');

    if (retries >= config.MAX_RECONNECT_RETRIES) {
      logger.error({ sessionId, retries }, 'Max reconnect retries reached');
      return;
    }

    const backoff = Math.min(config.RECONNECT_INTERVAL * Math.pow(2, retries), 60000);
    const jitter = Math.random() * 1000;
    const delay = backoff + jitter;

    logger.info({ sessionId, retries, delay }, 'Scheduling reconnect');

    const timeout = setTimeout(async () => {
      try {
        await redisClient.incr(retryKey);
        const session = this.sessions.get(sessionId);
        if (session) {
          session.socket?.ws?.close();
          this.sessions.delete(sessionId);
        }
        await this.createSession(sessionId);
      } catch (err) {
        logger.error({ sessionId, err }, 'Failed during reconnect attempt');
      }
    }, delay);

    this.reconnectTimeouts.set(sessionId, timeout);
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.socket?.ws?.close();
      this.sessions.delete(sessionId);
    }

    if (this.reconnectTimeouts.has(sessionId)) {
      clearTimeout(this.reconnectTimeouts.get(sessionId));
      this.reconnectTimeouts.delete(sessionId);
    }

    await clearSessionAuth(sessionId);
    logger.info({ sessionId }, 'Session deleted');
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    return Array.from(this.sessions.keys()).map(id => ({
      id,
      status: this.sessions.get(id).status
    }));
  }

  async recoverSessions() {
    try {
      let cursor = '0';
      const sessionIds = new Set();

      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', 'whatsapp:session:*:creds', 'COUNT', '100');
        cursor = nextCursor;
        for (const key of keys) {
          sessionIds.add(key.split(':')[2]);
        }
      } while (cursor !== '0');

      logger.info({ count: sessionIds.size }, 'Found sessions to recover');

      for (const id of sessionIds) {
        try {
          await this.createSession(id);
        } catch (err) {
          logger.error({ sessionId: id, err }, 'Failed to recover session');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to recover sessions');
    }
  }

  async shutdown() {
    logger.info('Shutting down Session Manager');
    for (const [id, session] of this.sessions.entries()) {
      try {
        session.socket?.ws?.close();
      } catch (err) {
        logger.error({ sessionId: id, err }, 'Error closing socket during shutdown');
      }
    }
  }
}

export const sessionManager = new SessionManager();
