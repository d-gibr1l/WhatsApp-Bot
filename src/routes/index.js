import { Router } from 'express';
import {
  createSession,
  getSessionStatus,
  deleteSession,
  listSessions,
  reconnectSession
} from '../controllers/session.js';
import { redisClient } from '../redis/client.js';
import { sessionManager } from '../sessions/manager.js';

const router = Router();

router.post('/session/create', createSession);
router.get('/session/:id/status', getSessionStatus);
router.delete('/session/:id', deleteSession);
router.get('/sessions', listSessions);
router.post('/session/:id/reconnect', reconnectSession);

router.get('/health', async (req, res) => {
  try {
    const redisStatus = redisClient.status;
    const activeSessions = sessionManager.getAllSessions().length;
    res.status(200).json({
      success: true,
      data: {
        status: 'ok',
        redis: redisStatus,
        activeSessions,
        uptime: process.uptime()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Health check failed' });
  }
});

export default router;
