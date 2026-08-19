import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireRole } from "../middleware/requireRole.js";
import { createFeedback, listFeedback, listPendingFeedback, getMyFeedbackStats } from "../controllers/feedbackController.js";

const router = Router();

router.post("/", requireAuth, createFeedback);
router.get("/pending", requireAuth, listPendingFeedback);
router.get("/me", requireAuth, requireRole("teacher"), getMyFeedbackStats);
router.get("/", requireAuth, requireAdmin, listFeedback);

export default router;
