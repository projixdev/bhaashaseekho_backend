import { connectDB } from "../config/db.js";
import Enrollment from "../models/Enrollment.js";

export async function getRoster(req, res) {
  try {
    await connectDB();

    const enrollments = await Enrollment.find({ tutor: req.user.id })
      .populate("student", "name phone")
      .sort({ createdAt: 1 })
      .lean();

    // Whitelisted field by field for the same reason as
    // enrollmentController.getMyEnrollments — Enrollment holds an admin-only
    // rate that belongs in neither of these responses. classesRemaining is
    // scheduling context a teacher legitimately needs; perClassCharge is not,
    // and is select: false besides.
    const students = enrollments
      .filter((e) => e.student)
      .map((e) => ({
        _id: e.student._id,
        name: e.student.name,
        phone: e.student.phone,
        courseSlug: e.courseSlug,
        batchType: e.batchType,
        classesRemaining: e.classesRemaining ?? 0,
      }));

    res.json({ success: true, students });
  } catch (err) {
    console.error("GET /api/roster failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
