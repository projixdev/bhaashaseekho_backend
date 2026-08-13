import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { listUpcomingClasses, endClass } from "../controllers/classController.js";

const router = Router();

router.get("/", requireAuth, listUpcomingClasses);
router.patch("/:id/end", requireAuth, requireRole("teacher"), endClass);

export default router;
