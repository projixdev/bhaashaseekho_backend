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

    const result = enrollments.map((e) => ({
      courseSlug: e.courseSlug,
      batchType: e.batchType,
      status: e.status,
      tutor: e.tutor ? { name: e.tutor.name } : null,
    }));

    res.json({ success: true, enrollments: result });
  } catch (err) {
    console.error("GET /api/enrollment/me failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
