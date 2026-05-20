import 'dotenv/config';
import express from 'express';
import Redis from 'ioredis';
import SessionManager from './manager/session-manager.js';
import { createRouter } from './api/routes.js';
import { logger } from './utils/logger.js';

const app = express();
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // Essential for Upstash
});

const manager = new SessionManager(redis);

app.use(express.json());

// Routes
app.use('/api', createRouter(manager));

// Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    sessions: manager.sessions.size 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info(`🚀 WA Manager Online on Port ${PORT}`);
  await manager.initRecovery();
});

// Clean shutdown
process.on('SIGTERM', async () => {
  logger.info('Graceful shutdown initiated...');
  for (const [id, s] of manager.sessions) {
    s.sock.end();
  }
  process.exit(0);
});