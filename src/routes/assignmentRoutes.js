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
// touch this server's disk. 10MB matches the client-side check in the app's
// src/lib/upload.ts (ROADMAP.md Phase 11) — keep both in sync if this changes.
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// Homework photos and assessment PDFs only — anything else (executables,
// archives, etc.) is rejected before it ever reaches Cloudinary.
function fileFilter(req, file, cb) {
  if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") {
    cb(null, true);
    return;
  }
  cb(new Error("UNSUPPORTED_FILE_TYPE"));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});

// multer forwards both oversize and fileFilter rejections to next(err), which
// would otherwise fall through to app.js's generic 500 handler. This turns
// them into a 400 with a message the app can show directly.
function uploadSingleFile(field) {
  const middleware = upload.single(field);
  return function handleUpload(req, res, next) {
    middleware(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ success: false, message: "File exceeds the 10MB limit." });
        return;
      }
      if (err.message === "UNSUPPORTED_FILE_TYPE") {
        res.status(400).json({ success: false, message: "Only images and PDF files are allowed." });
        return;
      }
      next(err);
    });
  };
}

const router = Router();

router.get("/", requireAuth, listAssignments);
router.post("/", requireAuth, requireRole("teacher"), uploadSingleFile("file"), createAssignment);
router.post("/:id/submit", requireAuth, uploadSingleFile("file"), submitAssignment);
router.patch("/:id/review", requireAuth, requireRole("teacher"), reviewAssignment);

export default router;
