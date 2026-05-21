import axios from 'axios';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

export const dispatchWebhook = async (sessionId, event, payload) => {
  if (!config.WEBHOOK_URL) return;

  try {
    await axios.post(config.WEBHOOK_URL, {
      sessionId,
      event,
      timestamp: Date.now(),
      payload
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });
  } catch (err) {
    logger.error({ sessionId, event, err: err.message }, 'Failed to dispatch webhook');
  }
};
