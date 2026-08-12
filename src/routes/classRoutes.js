import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { listUpcomingClasses } from "../controllers/classController.js";

const router = Router();

router.get("/", requireAuth, listUpcomingClasses);

export default router;
