import axios from 'axios';
import { logger } from '../utils/logger.js';

export const notifyWebhook = async (event, data) => {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;

  try {
    await axios.post(url, { event, data, timestamp: Date.now() }, { timeout: 5000 });
  } catch (err) {
    logger.error(`Webhook Failed: ${err.message}`);
  }
};