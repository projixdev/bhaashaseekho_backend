import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import { listMyTeachableCourses, requestTeachableCourse } from "../controllers/teacherCoursesController.js";

const router = Router();

router.get("/me", requireAuth, requireRole("teacher"), listMyTeachableCourses);
router.post("/", requireAuth, requireRole("teacher"), requestTeachableCourse);

export default router;
