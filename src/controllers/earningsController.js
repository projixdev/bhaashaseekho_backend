import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import TeacherEarning from "../models/TeacherEarning.js";

// Page size for the entry list. The two totals are never paginated — they're
// aggregated across the whole ledger, so scrolling can't change them.
const PAGE_SIZE = 50;

// A teacher's own payout ledger. Scoped to req.user.id as the *teacher*
// field, so this route has no way to return anyone else's rows regardless of
// what's in the query string.
//
// pointsPending/pointsPaid are aggregated from the same rows the list below
// is drawn from, not read off a cached counter — the number in the tile and
// the rows it's a sum of therefore can't disagree, and there's nothing to
// reconcile if a write is ever interrupted.
//
// chargedAmount is returned alongside points on purpose: they're the same
// information at a fixed multiple, and a teacher checking their payout
// against a class they actually taught needs to see the rate it was worked
// out from. This is the teacher's own earnings screen — the field boundary
// that matters is the student one, and nothing here is reachable from a
// student token (requireRole("teacher") on the route, plus the teacher-
// scoped filter).
export async function getMyEarnings(req, res) {
  try {
    await connectDB();

    const page = Math.max(1, Number(req.query.page) || 1);

    const [totals, entries, total] = await Promise.all([
      TeacherEarning.aggregate([
        { $match: { teacher: new mongoose.Types.ObjectId(req.user.id) } },
        { $group: { _id: "$status", points: { $sum: "$points" } } },
      ]),
      TeacherEarning.find({ teacher: req.user.id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .populate("student", "name")
        .lean(),
      TeacherEarning.countDocuments({ teacher: req.user.id }),
    ]);

    res.json({
      success: true,
      pointsPending: totals.find((t) => t._id === "pending")?.points ?? 0,
      pointsPaid: totals.find((t) => t._id === "paid")?.points ?? 0,
      page,
      hasMore: page * PAGE_SIZE < total,
      entries: entries.map((e) => ({
        _id: e._id,
        // First name only — the roster already gives a teacher the full
        // name, and a payout list reads better (and narrower) without it.
        studentName: e.student?.name?.trim().split(/\s+/)[0] ?? "Student",
        courseSlug: e.courseSlug,
        chargedAmount: e.chargedAmount,
        points: e.points,
        status: e.status,
        paidAt: e.paidAt,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    console.error("GET /api/teacher/earnings failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
