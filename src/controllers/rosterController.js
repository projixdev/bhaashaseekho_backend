import { connectDB } from "../config/db.js";
import Enrollment from "../models/Enrollment.js";

export async function getRoster(req, res) {
  try {
    await connectDB();

    const enrollments = await Enrollment.find({ tutor: req.user.id })
      .populate("student", "name phone")
      .sort({ createdAt: 1 })
      .lean();

    const students = enrollments
      .filter((e) => e.student)
      .map((e) => ({
        _id: e.student._id,
        name: e.student.name,
        phone: e.student.phone,
        courseSlug: e.courseSlug,
        batchType: e.batchType,
      }));

    res.json({ success: true, students });
  } catch (err) {
    console.error("GET /api/roster failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
