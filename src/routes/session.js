import express from "express";
import {
  createSession,
  getSessionStatus,
  deleteSession,
  listSessions,
  reconnectSession
} from "../controllers/sessionController.js";

const router = express.Router();

router.post("/create", createSession);
router.get("/:id/status", getSessionStatus);
router.delete("/:id", deleteSession);
router.get("/", listSessions);
router.post("/:id/reconnect", reconnectSession);

export default router;
