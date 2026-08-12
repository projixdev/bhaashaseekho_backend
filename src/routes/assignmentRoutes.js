import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  listAssignments,
  submitAssignment,
  createAssignment,
  reviewAssignment,
} from "../controllers/assignmentController.js";

// Memory storage — files go straight to Cloudinary's upload stream, never
// touch this server's disk. 20MB covers homework photos and PDF assessments
// comfortably.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

router.get("/", requireAuth, listAssignments);
router.post("/", requireAuth, requireRole("teacher"), upload.single("file"), createAssignment);
router.post("/:id/submit", requireAuth, upload.single("file"), submitAssignment);
router.patch("/:id/review", requireAuth, requireRole("teacher"), reviewAssignment);

export default router;
