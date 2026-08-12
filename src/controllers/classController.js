import { connectDB } from "../config/db.js";
import Class from "../models/Class.js";

// Students see classes they're enrolled in; teachers see classes they teach.
// Same endpoint, filter depends on req.user.role from the verified JWT.
export async function listUpcomingClasses(req, res) {
  try {
    await connectDB();

    const filter =
      req.user.role === "teacher" ? { tutor: req.user.id } : { students: req.user.id };
    // "upcoming" is a default, not a guarantee — nothing flips it to
    // "completed" yet (no Teacher UI to do so), so a class whose time has
    // already passed would otherwise still show as the next class. "live"
    // is exempt since it can legitimately be a few minutes past scheduledAt.
    filter.$or = [{ status: "live" }, { status: "upcoming", scheduledAt: { $gte: new Date() } }];

    const classes = await Class.find(filter)
      .sort({ scheduledAt: 1 })
      .populate("tutor", "name phone")
      .populate("students", "name phone")
      .lean();

    res.json({ success: true, classes });
  } catch (err) {
    console.error("GET /api/classes failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
