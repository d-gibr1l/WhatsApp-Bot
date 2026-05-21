import Redis from 'ioredis';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

export const redisClient = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redisClient.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redisClient.on('connect', () => {
  logger.info('Connected to Redis successfully');
});
