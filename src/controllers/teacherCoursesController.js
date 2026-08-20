import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { isValidCourseSlug } from "../utils/courseTaxonomy.js";

// A teacher's own approval status per course (Phase 22 course discovery) —
// for the app's "I can teach this" screen to render Teaching/Requested/
// Available against the fixed 12-combination taxonomy.
export async function listMyTeachableCourses(req, res) {
  try {
    await connectDB();

    const user = await User.findById(req.user.id).select("teachableCourses").lean();
    res.json({ success: true, teachableCourses: user?.teachableCourses ?? [] });
  } catch (err) {
    console.error("GET /api/teacher-courses/me failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Idempotent: re-requesting a course that's already pending or approved is
// a no-op, not a duplicate entry or an error — the app can call this freely
// from a tap without first checking current state itself.
export async function requestTeachableCourse(req, res) {
  try {
    const courseSlug = String(req.body.courseSlug || "").trim().toLowerCase();
    if (!isValidCourseSlug(courseSlug)) {
      res.status(400).json({ success: false, message: "Unknown courseSlug." });
      return;
    }

    await connectDB();

    const user = await User.findById(req.user.id).select("teachableCourses");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found." });
      return;
    }

    const already = user.teachableCourses.some((c) => c.courseSlug === courseSlug);
    if (!already) {
      user.teachableCourses.push({ courseSlug, status: "pending" });
      await user.save();
    }

    res.json({ success: true, teachableCourses: user.teachableCourses });
  } catch (err) {
    console.error("POST /api/teacher-courses failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
