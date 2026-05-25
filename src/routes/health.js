import express from "express";
import { healthCheck } from "../health/healthController.js";

const router = express.Router();

router.get("/", healthCheck);

export default router;
