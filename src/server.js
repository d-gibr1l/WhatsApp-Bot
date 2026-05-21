import express from 'express';
import config from './config/index.js';
import { logger } from './utils/logger.js';
import routes from './routes/index.js';
import { apiKeyMiddleware, errorHandler } from './middlewares/auth.js';
import { sessionManager } from './sessions/manager.js';
import { startHealthMonitor } from './monitoring/health.js';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Basic request logging
app.use((req, res, next) => {
  logger.info({ method: req.method, url: req.url }, 'Incoming request');
  next();
});

app.use(apiKeyMiddleware);
app.use('/', routes);
app.use(errorHandler);

const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);
  try {
    await sessionManager.shutdown();
    logger.info('Graceful shutdown completed successfully');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Rejection');
  gracefulShutdown('unhandledRejection');
});

const startServer = async () => {
  try {
    // Recover sessions on startup
    await sessionManager.recoverSessions();

    // Start background health monitoring
    startHealthMonitor();

    app.listen(config.PORT, () => {
      logger.info(`Server is running on port ${config.PORT}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

export default startServer;
