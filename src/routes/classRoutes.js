import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { listUpcomingClasses, createClass, endClass, updateClassStatus } from "../controllers/classController.js";

const router = Router();

router.get("/", requireAuth, listUpcomingClasses);
router.post("/", requireAuth, requireRole("teacher"), createClass);
router.patch("/:id/end", requireAuth, requireRole("teacher"), endClass);
router.patch("/:id/status", requireAuth, requireRole("teacher"), updateClassStatus);

export default router;
