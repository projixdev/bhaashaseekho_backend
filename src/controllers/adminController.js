import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import Enrollment from "../models/Enrollment.js";
import Class from "../models/Class.js";
import Assignment from "../models/Assignment.js";
import { ASSESSMENT_UNLOCK_AFTER_CLASSES } from "./assignmentController.js";

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

export async function listAdminStudents(req, res) {
  try {
    await connectDB();

    const students = await User.find({ role: "student" })
      .select("name phone email completedClassCount isTrial accessExpiresAt")
      .sort({ name: 1 })
      .lean();
    const studentIds = students.map((s) => s._id);

    const assignments = await Assignment.find({ student: { $in: studentIds } }).select("student type status").lean();

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
        assessmentsUnlocked: (s.completedClassCount ?? 0) >= ASSESSMENT_UNLOCK_AFTER_CLASSES,
        homework: bucket("homework"),
        assessments: bucket("assessment"),
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
