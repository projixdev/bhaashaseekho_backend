import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { getMyEarnings } from "../controllers/earningsController.js";

const router = Router();

// Teacher-only, and self-scoped inside the controller — there's deliberately
// no ":teacherId" variant here. Cross-teacher reads live behind requireAdmin
// on /api/admin/earnings instead.
router.get("/", requireAuth, requireRole("teacher"), getMyEarnings);

export default router;
