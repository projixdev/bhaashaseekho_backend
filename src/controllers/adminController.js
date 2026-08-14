import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import Enrollment from "../models/Enrollment.js";
import Class from "../models/Class.js";
import Assignment from "../models/Assignment.js";
import { ASSESSMENT_UNLOCK_AFTER_CLASSES } from "./assignmentController.js";
import { validatePhoneInput, normalizePhone, EMAIL_RE } from "../utils/validation.js";

// Password-based, web-only login for the admin dashboard (ROADMAP.md Phase
// 17) — a second way to authenticate the *same* isAdmin: true User the
// mobile app already knows about via OTP (Phase 15), not a second identity
// system. The resulting token carries role: "admin" (distinct from the
// student/teacher token's role: "student"|"teacher") so it can never
// satisfy requireRole("teacher")/requireRole("student") on the app's
// role-gated routes — see tests/adminDashboard.test.js's cross-contamination
// tests for the two directions this matters.
export async function adminLogin(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password || typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ success: false, message: "Email and password are required." });
      return;
    }

    await connectDB();

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    // Same message whether the email doesn't exist or the password is
    // wrong — doesn't leak which case it was.
    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      res.status(401).json({ success: false, message: "Incorrect email or password." });
      return;
    }

    // Defense in depth: never authenticate a non-admin here, even with a
    // correct password (e.g. a stray/leftover hash on a non-admin doc).
    if (!user.isAdmin) {
      res.status(403).json({ success: false, message: "This account does not have admin access." });
      return;
    }

    const token = jwt.sign({ sub: user._id.toString(), email: user.email, role: "admin", isAdmin: true }, env.jwtSecret, {
      expiresIn: "12h",
    });

    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("POST /api/admin/login failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Moves teacher creation off scripts/createUser.js and into the admin
// dashboard — same fields/defaults as that script's --role teacher path
// (name, phone, role: "teacher", email if given, no password, no
// Enrollment — that block is student-only there too), so a
// dashboard-created teacher is indistinguishable from a CLI-created one.
// One deliberate difference: the script upserts by phone (safe to re-run);
// this route rejects a duplicate phone outright rather than silently
// overwriting an existing account from a web form.
export async function createTeacher(req, res) {
  try {
    const { name, phone, email } = req.body;
    const errors = {};

    if (typeof name !== "string" || !name.trim()) {
      errors.name = "Name is required.";
    } else if (name.trim().length > 120) {
      errors.name = "Name is too long.";
    }

    // Reuses send-otp's own phone-format check (utils/validation.js) rather
    // than a second copy of the same regex.
    const { valid: phoneValid, errors: phoneErrors } = validatePhoneInput({ phone });
    if (!phoneValid) Object.assign(errors, phoneErrors);

    if (email !== undefined && email !== null && email !== "") {
      if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        errors.email = "Please enter a valid email address.";
      } else if (email.trim().length > 160) {
        errors.email = "Email is too long.";
      }
    }

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    await connectDB();

    const normalizedPhone = normalizePhone(phone);
    const normalizedEmail = email ? email.trim().toLowerCase() : undefined;

    let teacher;
    try {
      teacher = await User.create({
        phone: normalizedPhone,
        name: name.trim(),
        role: "teacher",
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
      });
    } catch (err) {
      if (err.code === 11000) {
        // phone and email are both unique-indexed — report whichever one
        // actually collided instead of assuming it was the phone.
        const field = err.keyPattern?.email ? "email" : "phone";
        res.status(409).json({
          success: false,
          message:
            field === "email"
              ? "This email is already registered to another account."
              : "This phone number is already registered.",
        });
        return;
      }
      throw err;
    }

    res.status(201).json({
      success: true,
      teacher: { _id: teacher._id, name: teacher.name, phone: teacher.phone, email: teacher.email || null },
    });
  } catch (err) {
    console.error("POST /api/admin/teachers failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Plain find() + JS grouping rather than aggregation pipelines — this is
// founder-scale data (tens of teachers/students), and a readable, easy-to-
// verify query beats a cleverer one nobody asked for.
export async function listAdminTeachers(req, res) {
  try {
    await connectDB();

    const teachers = await User.find({ role: "teacher" }).select("name phone email").sort({ name: 1 }).lean();
    const teacherIds = teachers.map((t) => t._id);

    const [enrollments, classes] = await Promise.all([
      // Active enrollments only — a paused/completed one isn't "currently
      // assigned" for the founder's purposes.
      Enrollment.find({ tutor: { $in: teacherIds }, status: "active" }).select("tutor").lean(),
      Class.find({ tutor: { $in: teacherIds } }).select("tutor status").lean(),
    ]);

    const result = teachers.map((t) => {
      const idStr = t._id.toString();
      const ownClasses = classes.filter((c) => c.tutor.toString() === idStr);
      return {
        _id: t._id,
        name: t.name,
        phone: t.phone,
        email: t.email || null,
        assignedStudentCount: enrollments.filter((e) => e.tutor.toString() === idStr).length,
        classesScheduled: ownClasses.length,
        classesCompleted: ownClasses.filter((c) => c.status === "completed").length,
      };
    });

    res.json({ success: true, teachers: result });
  } catch (err) {
    console.error("GET /api/admin/teachers failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Priority order matters: a student with even one still-"assigned" item is
// "pending" (something outstanding) even if everything else is reviewed;
// "submitted" only once nothing is left pending; "reviewed" only once
// nothing is left pending or awaiting review. Computed across homework and
// assessments together — the admin Students page wants one overall status
// per student, not a separate badge per assignment type.
function overallAssignmentStatus(items) {
  if (items.length === 0) return "none";
  if (items.some((a) => a.status === "assigned")) return "pending";
  if (items.some((a) => a.status === "submitted")) return "submitted";
  return "reviewed";
}

export async function listAdminStudents(req, res) {
  try {
    await connectDB();

    const students = await User.find({ role: "student" })
      .select("name phone email completedClassCount isTrial accessExpiresAt")
      .sort({ name: 1 })
      .lean();
    const studentIds = students.map((s) => s._id);

    const [assignments, enrollments] = await Promise.all([
      Assignment.find({ student: { $in: studentIds } }).select("student type status").lean(),
      // Active enrollments only — same "currently assigned" definition
      // listAdminTeachers already uses. populate("tutor", "name") since a
      // student can have a different tutor per course and the page needs
      // to show all of them, not just one.
      Enrollment.find({ student: { $in: studentIds }, status: "active" })
        .select("student courseSlug tutor")
        .populate("tutor", "name")
        .lean(),
    ]);

    const result = students.map((s) => {
      const idStr = s._id.toString();
      const own = assignments.filter((a) => a.student.toString() === idStr);
      const bucket = (type) => {
        const items = own.filter((a) => a.type === type);
        return { assigned: items.length, submitted: items.filter((a) => a.status !== "assigned").length };
      };

      return {
        _id: s._id,
        name: s.name,
        phone: s.phone,
        email: s.email || null,
        // .lean() returns the raw document — a student created before
        // completedClassCount/isTrial existed (Phases 13/14) never had them
        // actually written, so the key is missing outright, not 0/false.
        // Same fallback assignmentController.js's gate already relies on.
        completedClassCount: s.completedClassCount ?? 0,
        // Exposed explicitly rather than leaving the admin UI to hardcode
        // "10" — same constant the real student-facing gate reads from, not
        // a second copy of the threshold.
        assessmentsUnlockAt: ASSESSMENT_UNLOCK_AFTER_CLASSES,
        assessmentsUnlocked: (s.completedClassCount ?? 0) >= ASSESSMENT_UNLOCK_AFTER_CLASSES,
        homework: bucket("homework"),
        assessments: bucket("assessment"),
        assignmentStatus: overallAssignmentStatus(own),
        teachers: enrollments
          .filter((e) => e.student.toString() === idStr)
          .map((e) => ({ courseSlug: e.courseSlug, name: e.tutor?.name ?? null })),
        isTrial: Boolean(s.isTrial),
        accessExpiresAt: s.isTrial ? s.accessExpiresAt : null,
      };
    });

    res.json({ success: true, students: result });
  } catch (err) {
    console.error("GET /api/admin/students failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
