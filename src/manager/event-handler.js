import { handleMessage } from "../handler.js";
import { logger } from "../utils/logger.js";

export const bindEvents = (sessionId, sock) => {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      logger.info("Message in " + sessionId + " from " + msg.key.remoteJid);
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error("Error in bot handler: " + err.message);
      }
    }
  });
};