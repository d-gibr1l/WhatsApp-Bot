import makeWASocket, { 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore 
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import { useRedisAuthState } from '../auth/redis-store.js';
import { bindEvents } from './event-handler.js';
import { logger } from '../utils/logger.js';

class SessionManager {
  constructor(redis) {
    this.redis = redis;
    this.sessions = new Map(); // In-memory socket registry
    this.msgRetryCounterCache = new NodeCache();
  }

  async createSession(sessionId, res = null) {
    // 1. Prevent duplicate initialization
    if (this.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already active.`);
      return { status: 'already_active' };
    }

    // 2. Redis Locking to prevent Bad MAC (Session overlap)
    const lockKey = `whatsapp:session:${sessionId}:lock`;
    const acquired = await this.redis.set(lockKey, 'locked', 'NX', 'EX', 60);
    if (!acquired) {
      logger.error(`Session ${sessionId} is locked by another process.`);
      throw new Error('Session is currently initializing elsewhere.');
    }

    try {
      const { state, saveCreds } = await useRedisAuthState(this.redis, sessionId);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache: this.msgRetryCounterCache,
        browser: ['Koyeb', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: true,
      });

      // Store basic state
      this.sessions.set(sessionId, { sock, status: 'connecting' });

      // Handle Creds Persistence
      sock.ev.on('creds.update', saveCreds);

      // Handle Connection Events
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && res && !res.headersSent) {
          res.json({ status: 'qr_required', qr });
        }

        if (connection === 'open') {
          logger.info(`✅ Session Connected: ${sessionId}`);
          this.sessions.set(sessionId, { sock, status: 'connected' });
          await this.redis.del(lockKey); // Release lock on success
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;

          logger.warn(`❌ Connection closed for ${sessionId}. Code: ${code}. Reconnecting: ${shouldReconnect}`);
          
          this.sessions.delete(sessionId);
          await this.redis.del(lockKey);

          if (shouldReconnect) {
            setTimeout(() => this.createSession(sessionId), 5000);
          }
        }
      });

      // Bind your bot commands (handler.js logic)
      bindEvents(sessionId, sock);

      return { status: 'initializing' };

    } catch (err) {
      await this.redis.del(lockKey);
      logger.error(`Failed to create session ${sessionId}: ${err.message}`);
      throw err;
    }
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session?.sock) {
      try {
        await session.sock.logout();
        session.sock.end();
      } catch (e) { /* ignore */ }
    }
    this.sessions.delete(sessionId);
    
    // Wipe all Redis keys for this session
    const keys = await this.redis.keys(`whatsapp:session:${sessionId}:*`);
    if (keys.length > 0) await this.redis.del(...keys);
    logger.info(`🗑️ Session ${sessionId} fully deleted.`);
  }

  async initRecovery() {
    logger.info('Searching Redis for sessions to recover...');
    const keys = await this.redis.keys('whatsapp:session:*:creds');
    const ids = keys.map(k => k.split(':')[2]);

    for (const id of ids) {
      logger.info(`♻️ Recovering session: ${id}`);
      this.createSession(id).catch(e => logger.error(`Recovery failed for ${id}: ${e.message}`));
    }
  }
}

export default SessionManager;