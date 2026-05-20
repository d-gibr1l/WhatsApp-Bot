import express from 'express';
import { apiKeyAuth } from './middleware.js';

export const createRouter = (manager) => {
  const router = express.Router();

  router.post('/sessions', apiKeyAuth, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Session ID required' });
    try {
      const result = await manager.createSession(id, res);
      // If it's already active, return 200, otherwise createSession handles QR response
      if (result.status === 'already_active') res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/sessions', apiKeyAuth, (req, res) => {
    const list = Array.from(manager.sessions.entries()).map(([id, s]) => ({
      id,
      status: s.status,
    }));
    res.json(list);
  });

  router.delete('/sessions/:id', apiKeyAuth, async (req, res) => {
    await manager.deleteSession(req.params.id);
    res.json({ success: true });
  });

  return router;
};