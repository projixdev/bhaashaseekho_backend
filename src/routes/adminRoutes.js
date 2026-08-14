import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { adminLogin, listAdminTeachers, listAdminStudents, createTeacher } from "../controllers/adminController.js";

const router = Router();

// Own rate-limit bucket, same pattern as every other public POST endpoint
// (send-otp, leads, contact) — not reusing one of those since this is a
// distinct credential-guessing target, not a variant of an existing form.
router.post("/login", rateLimit("admin-login"), adminLogin);

// requireAdmin already exists (Phase 15) — reused as-is, not duplicated.
router.get("/teachers", requireAuth, requireAdmin, listAdminTeachers);
router.post("/teachers", requireAuth, requireAdmin, createTeacher);
router.get("/students", requireAuth, requireAdmin, listAdminStudents);

export default router;
