import { connectDB } from "../config/db.js";
import Enrollment from "../models/Enrollment.js";

// A student's own enrollments (course + tutor), for the app's own Profile
// screen — the teacher-facing equivalent (one row per student) is
// rosterController.getRoster; this is the mirror view, scoped by
// req.user.id as the *student* field, so a teacher calling it just gets an
// empty array rather than needing a role check.
export async function getMyEnrollments(req, res) {
  try {
    await connectDB();

    const enrollments = await Enrollment.find({ student: req.user.id })
      .populate("tutor", "name")
      .sort({ createdAt: 1 })
      .lean();

    // Explicit whitelist, not a spread of the document. This is the one
    // student-facing view of an Enrollment, and Enrollment carries an
    // admin-only rate (perClassCharge) that must never reach a student under
    // any field name — building the response field by field means adding a
    // column to the model can't leak it here by default. perClassCharge is
    // additionally select: false, so it isn't even on `e` to be copied.
    const result = enrollments.map((e) => ({
      courseSlug: e.courseSlug,
      batchType: e.batchType,
      status: e.status,
      tutor: e.tutor ? { name: e.tutor.name } : null,
      // Plain count of sessions already paid for off-app and not yet
      // attended. A number, never a rupee figure and never convertible to
      // one from anything else in this response.
      classesRemaining: e.classesRemaining ?? 0,
    }));

    res.json({ success: true, enrollments: result });
  } catch (err) {
    console.error("GET /api/enrollment/me failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
