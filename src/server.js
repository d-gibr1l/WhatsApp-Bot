import express from "express";
import pino from "pino";
import dotenv from "dotenv";
import healthRoutes from "./routes/health.js";
import sessionRoutes from "./routes/session.js";
import { authMiddleware } from "./middlewares/authMiddleware.js";
import { sessionManager } from "./sessions/SessionManager.js";
import { redisClient } from "./redis/redisClient.js";

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/health", healthRoutes);
app.use("/session", authMiddleware, sessionRoutes);
app.use("/sessions", authMiddleware, sessionRoutes);

// Startup Recovery
const recoverSessions = async () => {
  logger.info("Scanning Redis for existing sessions to recover...");
  try {
    const keys = await redisClient.keys("whatsapp:session:*:creds");
    if (keys.length === 0) {
      logger.info("No existing sessions found in Redis.");
      return;
    }

    const sessionIds = keys.map(k => k.split(":")[2]);
    logger.info(`Found ${sessionIds.length} session(s) in Redis. Attempting to restore...`);

    for (const id of sessionIds) {
      try {
        await sessionManager.createSession(id);
      } catch (err) {
        logger.error({ sessionId: id, error: err.message }, "Failed to recover session");
      }
    }
  } catch (err) {
    logger.error({ error: err.message }, "Error during session recovery");
  }
};

const server = app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  await recoverSessions();
});

// Graceful Shutdown
const shutdown = async (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Close HTTP server
  server.close(async () => {
    logger.info("HTTP server closed.");

    // Disconnect all sessions cleanly
    for (const [id, session] of sessionManager.sessions.entries()) {
      logger.info(`Closing session ${id}`);
      try { session.sock.ev.removeAllListeners(); } catch {}
      try { session.sock.ws?.close(); } catch {}
    }

    // Close redis connection
    try {
      await redisClient.quit();
      logger.info("Redis connection closed.");
    } catch (err) {
      logger.error("Error closing Redis connection", err);
    }

    process.exit(0);
  });

  // Force exit if graceful shutdown fails
  setTimeout(() => {
    logger.error("Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logger.error(err, "Uncaught Exception");
});
process.on("unhandledRejection", (reason) => {
  logger.error(reason, "Unhandled Rejection");
});
