import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { createFeedback, listFeedback, listPendingFeedback } from "../controllers/feedbackController.js";

const router = Router();

router.post("/", requireAuth, createFeedback);
router.get("/pending", requireAuth, listPendingFeedback);
router.get("/", requireAuth, requireAdmin, listFeedback);

export default router;
