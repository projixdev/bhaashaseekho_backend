import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { getMyEnrollments } from "../controllers/enrollmentController.js";

const router = Router();

router.get("/me", requireAuth, getMyEnrollments);

export default router;
