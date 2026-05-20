import { handleMessage } from '../handler.js'; // The bridge to your existing bot logic
import { logger } from '../utils/logger.js';

export const bindEvents = (sessionId, sock) => {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // This sends the message into your existing command system
      try {
        await handleMessage(sock, msg); 
      } catch (err) {
        logger.error(`Error in bot logic for session ${sessionId}: ${err.message}`);
      }
    }
  });

  // Keep your other event listeners (group updates, etc.) here
};