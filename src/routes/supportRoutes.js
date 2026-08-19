import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { sendSupportMessage } from "../controllers/supportController.js";

const router = Router();

router.post("/", requireAuth, rateLimit("support"), sendSupportMessage);

export default router;
