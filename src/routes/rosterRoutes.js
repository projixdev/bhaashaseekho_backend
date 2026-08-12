import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { getRoster } from "../controllers/rosterController.js";

const router = Router();

router.get("/", requireAuth, requireRole("teacher"), getRoster);

export default router;
