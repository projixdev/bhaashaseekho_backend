import { connectDB } from "../config/db.js";
import Class from "../models/Class.js";
import Enrollment from "../models/Enrollment.js";
import User from "../models/User.js";

// Students see classes they're enrolled in; teachers see classes they teach.
// Same endpoint, filter depends on req.user.role from the verified JWT.
export async function listUpcomingClasses(req, res) {
  try {
    await connectDB();

    const filter =
      req.user.role === "teacher" ? { tutor: req.user.id } : { students: req.user.id };

    if (req.user.role === "teacher") {
      // Teachers also need to see a class whose scheduled time has already
      // passed but hasn't been ended yet (ROADMAP.md Phase 13) — that's
      // exactly the class endClass exists to act on, so it can't be
      // filtered out by scheduledAt the way it is for students below.
      filter.$or = [{ status: "live" }, { status: "upcoming" }];
    } else {
      // "upcoming" is a default, not a guarantee for a student's view — a
      // class whose time has passed but the tutor hasn't ended yet would
      // otherwise still show as their "next" class. "live" is exempt since
      // it can legitimately be a few minutes past scheduledAt.
      filter.$or = [{ status: "live" }, { status: "upcoming", scheduledAt: { $gte: new Date() } }];
    }

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

// App-flow counterpart to scripts/scheduleClass.js, now that a teacher can
// do this themselves instead of asking an admin to run the CLI script.
// Mirrors the script's exact creation logic/defaults (durationMinutes 45,
// meetingLink left empty — Zoom integration is on hold) — the only real
// difference is the ownership check, which the CLI script skips since
// whoever runs it is trusted, but an HTTP endpoint can't assume that.
export async function createClass(req, res) {
  try {
    const { studentId, subject, scheduledAt, durationMinutes } = req.body;

    if (!studentId || typeof subject !== "string" || !subject.trim() || !scheduledAt) {
      res.status(400).json({ success: false, message: "studentId, subject, and scheduledAt are required." });
      return;
    }

    const parsedScheduledAt = new Date(scheduledAt);
    if (Number.isNaN(parsedScheduledAt.getTime())) {
      res.status(400).json({ success: false, message: "Invalid scheduledAt date." });
      return;
    }

    await connectDB();

    // Only students on this teacher's own roster — same check/message as
    // assignmentController.createAssignment.
    const enrollment = await Enrollment.findOne({ tutor: req.user.id, student: studentId });
    if (!enrollment) {
      res.status(403).json({ success: false, message: "This student isn't assigned to you." });
      return;
    }

    const cls = await Class.create({
      subject: subject.trim(),
      tutor: req.user.id,
      students: [studentId],
      batchType: "1-on-1",
      scheduledAt: parsedScheduledAt,
      durationMinutes: durationMinutes ? Number(durationMinutes) : 45,
      meetingLink: "",
    });

    res.json({ success: true, class: cls });
  } catch (err) {
    console.error("POST /api/classes failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

const VALID_ATTENDANCE_STATUSES = ["present", "partial", "absent"];

// Ends a class: records per-student attendance and increments
// completedClassCount for everyone marked "present". Idempotency is the
// critical property here — a double-tap, retry, or two concurrent requests
// must never double-count. Guarded atomically via findOneAndUpdate's status
// filter below, not a read-then-write check in JS, so it holds even if two
// requests for the same class are in flight at the same time.
export async function endClass(req, res) {
  try {
    await connectDB();

    const classDoc = await Class.findById(req.params.id);
    if (!classDoc) {
      res.status(404).json({ success: false, message: "Class not found." });
      return;
    }
    if (classDoc.tutor.toString() !== req.user.id) {
      res.status(403).json({ success: false, message: "You don't teach this class." });
      return;
    }

    const attendance = Array.isArray(req.body.attendance) ? req.body.attendance : [];
    const enrolledIds = classDoc.students.map((id) => id.toString());
    const submittedIds = attendance.map((entry) => String(entry.studentId));

    if (submittedIds.length !== enrolledIds.length || enrolledIds.some((id) => !submittedIds.includes(id))) {
      res.status(400).json({ success: false, message: "Attendance must include every enrolled student exactly once." });
      return;
    }
    if (submittedIds.some((id) => !enrolledIds.includes(id))) {
      res.status(400).json({ success: false, message: "Attendance includes a student not enrolled in this class." });
      return;
    }
    if (attendance.some((entry) => !VALID_ATTENDANCE_STATUSES.includes(entry.status))) {
      res.status(400).json({ success: false, message: "Invalid attendance status." });
      return;
    }

    // Only the request that actually flips status away from "completed"
    // proceeds past this point — a second call (sequential or concurrent)
    // matches zero documents and falls into the 409 branch below instead.
    const updatedClass = await Class.findOneAndUpdate(
      { _id: classDoc._id, status: { $ne: "completed" } },
      {
        $set: {
          status: "completed",
          attendance: attendance.map((entry) => ({ student: entry.studentId, status: entry.status })),
        },
      },
      { returnDocument: "after" }
    );

    if (!updatedClass) {
      res.status(409).json({ success: false, message: "This class has already been ended." });
      return;
    }

    const presentIds = attendance.filter((entry) => entry.status === "present").map((entry) => entry.studentId);
    if (presentIds.length > 0) {
      await User.updateMany({ _id: { $in: presentIds } }, { $inc: { completedClassCount: 1 } });
    }

    res.json({ success: true, class: updatedClass });
  } catch (err) {
    console.error("PATCH /api/classes/:id/end failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
