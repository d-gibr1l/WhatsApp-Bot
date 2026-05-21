import { sessionManager } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import QRCode from 'qrcode';

export const createSession = async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'Session ID is required' });
    }

    const existing = sessionManager.getSession(sessionId);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Session already exists' });
    }

    const session = await sessionManager.createSession(sessionId);

    // Wait briefly for QR code generation if needed
    let retries = 0;
    while (!session.qr && session.status !== 'connected' && retries < 10) {
      await new Promise(resolve => setTimeout(resolve, 500));
      retries++;
    }

    if (session.qr) {
      const qrDataURL = await QRCode.toDataURL(session.qr);
      return res.status(200).json({ success: true, data: { sessionId, status: session.status, qr: qrDataURL } });
    }

    res.status(200).json({ success: true, data: { sessionId, status: session.status } });
  } catch (err) {
    logger.error({ err }, 'Create session error');
    next(err);
  }
};

export const getSessionStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const response = { sessionId: id, status: session.status };
    if (session.qr) {
      response.qr = await QRCode.toDataURL(session.qr);
    }

    res.status(200).json({ success: true, data: response });
  } catch (err) {
    next(err);
  }
};

export const deleteSession = async (req, res, next) => {
  try {
    const { id } = req.params;
    await sessionManager.deleteSession(id);
    res.status(200).json({ success: true, message: 'Session deleted' });
  } catch (err) {
    next(err);
  }
};

export const listSessions = async (req, res, next) => {
  try {
    const sessions = sessionManager.getAllSessions();
    res.status(200).json({ success: true, data: sessions });
  } catch (err) {
    next(err);
  }
};

export const reconnectSession = async (req, res, next) => {
  try {
    const { id } = req.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    sessionManager.reconnectSession(id);
    res.status(200).json({ success: true, message: 'Reconnect scheduled' });
  } catch (err) {
    next(err);
  }
};
