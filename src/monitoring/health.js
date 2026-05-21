import { sessionManager } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import { redisClient } from '../redis/client.js';

export const startHealthMonitor = (interval = 60000) => {
  setInterval(async () => {
    const sessions = sessionManager.getAllSessions();

    for (const { id, status } of sessions) {
      try {
        const session = sessionManager.getSession(id);
        if (!session || !session.socket) continue;

        // Basic socket health check by checking WS connection state
        const wsState = session.socket.ws?.readyState;

        const healthData = {
          status,
          wsState,
          lastCheck: Date.now(),
          uptime: process.uptime()
        };

        await redisClient.set(`whatsapp:session:${id}:health`, JSON.stringify(healthData));

        if (status === 'connected' && wsState !== 1) { // 1 is OPEN
          logger.warn({ sessionId: id, wsState }, 'Detected frozen socket, forcing reconnect');
          sessionManager.reconnectSession(id);
        }

      } catch (err) {
        logger.error({ sessionId: id, err }, 'Health monitor error');
      }
    }
  }, interval);
};
