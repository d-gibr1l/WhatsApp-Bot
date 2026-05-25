import { sessionManager } from "../sessions/SessionManager.js";
import QRCode from "qrcode";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" }).child({ module: "SessionController" });

export const createSession = async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    const session = await sessionManager.createSession(sessionId);

    // Wait briefly to see if QR code generates
    if (session.status === "starting" || session.status === "connecting") {
       await new Promise(resolve => setTimeout(resolve, 3000));
    }

    if (session.qr) {
       const qrDataUrl = await QRCode.toDataURL(session.qr);
       return res.status(200).json({ sessionId, status: session.status, qr: qrDataUrl });
    }

    res.status(200).json({ sessionId, status: session.status });
  } catch (error) {
    logger.error({ sessionId, error: error.message }, "Error creating session");
    res.status(500).json({ error: "Failed to create session" });
  }
};

export const getSessionStatus = async (req, res) => {
  const { id } = req.params;
  const session = sessionManager.getSession(id);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const payload = { sessionId: id, status: session.status };

  if (session.status === "qr_required" && session.qr) {
      payload.qr = await QRCode.toDataURL(session.qr);
  }

  res.status(200).json(payload);
};

export const deleteSession = async (req, res) => {
  const { id } = req.params;
  await sessionManager.deleteSession(id);
  res.status(200).json({ success: true, message: `Session ${id} deleted` });
};

export const listSessions = (req, res) => {
  const sessions = sessionManager.getAllSessions();
  res.status(200).json({ sessions });
};

export const reconnectSession = async (req, res) => {
  const { id } = req.params;

  const session = sessionManager.getSession(id);
  if (!session) {
      return res.status(404).json({ error: "Session not found" });
  }

  try {
     // Close current socket safely
     try { session.sock.ev.removeAllListeners(); } catch {}
     try { session.sock.ws?.close(); } catch {}
     session.status = "disconnected";

     // Re-create
     await sessionManager.createSession(id);
     res.status(200).json({ success: true, message: `Reconnecting session ${id}` });
  } catch (err) {
     res.status(500).json({ error: "Failed to reconnect" });
  }
};
