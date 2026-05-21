import dotenv from 'dotenv';
dotenv.config();

export default {
  PORT: process.env.PORT || 3000,
  REDIS_URL: process.env.REDIS_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  API_KEY: process.env.API_KEY,
  WEBHOOK_URL: process.env.WEBHOOK_URL,
  RECONNECT_INTERVAL: parseInt(process.env.RECONNECT_INTERVAL) || 5000,
  MAX_RECONNECT_RETRIES: parseInt(process.env.MAX_RECONNECT_RETRIES) || 5,
};
