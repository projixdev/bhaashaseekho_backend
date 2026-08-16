import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  adminLogin,
  listAdminTeachers,
  createTeacher,
  getAdminTeacher,
  updateTeacher,
  deleteTeacher,
  listAdminStudents,
  createStudent,
  getAdminStudent,
  updateStudent,
  deleteStudent,
} from "../controllers/adminController.js";

const router = Router();

// Own rate-limit bucket, same pattern as every other public POST endpoint
// (send-otp, leads, contact) — not reusing one of those since this is a
// distinct credential-guessing target, not a variant of an existing form.
router.post("/login", rateLimit("admin-login"), adminLogin);

// requireAdmin already exists (Phase 15) — reused as-is, not duplicated.
router.get("/teachers", requireAuth, requireAdmin, listAdminTeachers);
router.post("/teachers", requireAuth, requireAdmin, createTeacher);
router.get("/teachers/:id", requireAuth, requireAdmin, getAdminTeacher);
router.patch("/teachers/:id", requireAuth, requireAdmin, updateTeacher);
router.delete("/teachers/:id", requireAuth, requireAdmin, deleteTeacher);

router.get("/students", requireAuth, requireAdmin, listAdminStudents);
router.post("/students", requireAuth, requireAdmin, createStudent);
router.get("/students/:id", requireAuth, requireAdmin, getAdminStudent);
router.patch("/students/:id", requireAuth, requireAdmin, updateStudent);
router.delete("/students/:id", requireAuth, requireAdmin, deleteStudent);

export default router;
