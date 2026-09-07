import { connectDB } from "../config/db.js";
import Class from "../models/Class.js";
import Enrollment from "../models/Enrollment.js";
import TeacherEarning from "../models/TeacherEarning.js";
import User from "../models/User.js";
import { pointsForCharge } from "../constants/earnings.js";
import { notifyClassStatusChange } from "../services/classNotifications.js";
import { createMeetEvent, updateMeetEventTime, deleteMeetEvent } from "../services/googleCalendarService.js";

// Students see classes they're enrolled in; teachers see classes they teach.
// Same endpoint, filter depends on req.user.role from the verified JWT.
//
// ?from=&to= (both required together, ISO strings) switches this from the
// default "upcoming/live" view to a plain date-range view of every status —
// the teacher app's week calendar needs to show a Monday's already-completed
// or cancelled class alongside Friday's still-upcoming one, which the
// status-filtered default can't do (Phase 19 Part 3). Omitting both keeps
// the original behavior exactly as before, so nothing else calling this
// endpoint is affected.
export async function listUpcomingClasses(req, res) {
  try {
    await connectDB();

    const filter =
      req.user.role === "teacher" ? { tutor: req.user.id } : { students: req.user.id };

    const { from, to } = req.query;
    if (from && to) {
      const parsedFrom = new Date(from);
      const parsedTo = new Date(to);
      if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime())) {
        res.status(400).json({ success: false, message: "Invalid from/to date." });
        return;
      }
      filter.scheduledAt = { $gte: parsedFrom, $lt: parsedTo };
    } else if (req.user.role === "teacher") {
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

    const response = { success: true, classes };

    // Both stats below are for the app's Profile screen — piggyback on
    // this endpoint (already the one each role's Home/Classes screens
    // call) rather than a whole new route just for a couple of numbers.
    if (req.user.role === "teacher") {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      const [completedCount, completedThisMonthCount] = await Promise.all([
        Class.countDocuments({ tutor: req.user.id, status: "completed" }),
        Class.countDocuments({
          tutor: req.user.id,
          status: "completed",
          scheduledAt: { $gte: monthStart, $lt: monthEnd },
        }),
      ]);
      response.completedCount = completedCount;
      response.completedThisMonthCount = completedThisMonthCount;
    } else {
      // % of this student's own attendance entries marked "present" across
      // every completed class they were in — "partial" doesn't count as
      // present here, same as everywhere else attendance status is treated
      // as a strict tri-state rather than a fraction.
      const completedClasses = await Class.find({ students: req.user.id, status: "completed" })
        .select("attendance")
        .lean();
      const myEntries = completedClasses
        .map((c) => c.attendance.find((a) => a.student.toString() === req.user.id))
        .filter(Boolean);
      response.attendancePercent = myEntries.length
        ? Math.round((myEntries.filter((e) => e.status === "present").length / myEntries.length) * 100)
        : null;
    }

    res.json(response);
  } catch (err) {
    console.error("GET /api/classes failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// App-flow counterpart to scripts/scheduleClass.js, now that a teacher can
// do this themselves instead of asking an admin to run the CLI script.
// Mirrors the script's exact creation logic/defaults (durationMinutes 45) —
// the only real differences are the ownership check, which the CLI script
// skips since whoever runs it is trusted, and that a Meet link is always
// auto-generated here rather than optionally passed in.
export async function createClass(req, res) {
  try {
    const { studentId, subject, scheduledAt, durationMinutes, courseSlug } = req.body;

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
    // assignmentController.createAssignment. courseSlug narrows it to one
    // specific enrollment when the app sends it (the Add Class sheet always
    // does, since it picks the course from this same roster): a student can
    // hold two courses with the same teacher, and endClass later needs to
    // know which one this class charges against. Omitting it stays valid —
    // an older app build, or a student with only one course — and just
    // leaves the class unattributed, which endClass handles.
    const enrollmentFilter = { tutor: req.user.id, student: studentId };
    if (typeof courseSlug === "string" && courseSlug.trim()) {
      enrollmentFilter.courseSlug = courseSlug.trim().toLowerCase();
    }
    const enrollment = await Enrollment.findOne(enrollmentFilter);
    if (!enrollment) {
      res.status(403).json({ success: false, message: "This student isn't assigned to you." });
      return;
    }

    const resolvedDuration = durationMinutes ? Number(durationMinutes) : 45;

    // Real emails so Meet recognizes the tutor/student as already-invited
    // and skips the "ask to join" knock — otherwise, since the event's
    // organizer is GOOGLE_WORKSPACE_USER_EMAIL (an identity nobody actually
    // sits in), nobody could ever be admitted. Only matters when they're
    // actually signed into Meet as that exact address; email is optional on
    // a teacher account (Phase 17), so this degrades to "that person still
    // has to knock" rather than failing the whole request if it's missing.
    const [tutor, student] = await Promise.all([
      User.findById(req.user.id).select("email").lean(),
      User.findById(studentId).select("email").lean(),
    ]);
    const attendeeEmails = [tutor?.email, student?.email].filter(Boolean);

    // Meet link generated before the class doc is ever written — a failure
    // here must not leave a class saved with an empty meetingLink (Phase 19
    // Part 1.3); the teacher gets a clear error and can just retry Save.
    let meetingLink;
    let googleCalendarEventId;
    try {
      const meetEvent = await createMeetEvent({
        subject: subject.trim(),
        scheduledAt: parsedScheduledAt,
        durationMinutes: resolvedDuration,
        attendeeEmails,
      });
      meetingLink = meetEvent.meetingLink;
      googleCalendarEventId = meetEvent.eventId;
    } catch (err) {
      console.error("Google Calendar event creation failed for a new class:", err);
      res.status(502).json({ success: false, message: "Could not create the meeting link. Please try again." });
      return;
    }

    const cls = await Class.create({
      subject: subject.trim(),
      tutor: req.user.id,
      students: [studentId],
      batchType: "1-on-1",
      // Taken from the enrollment actually matched above, not echoed back
      // from the request body — so it can only ever name a course this
      // student is really enrolled in with this teacher.
      courseSlug: enrollment.courseSlug,
      scheduledAt: parsedScheduledAt,
      durationMinutes: resolvedDuration,
      meetingLink,
      googleCalendarEventId,
    });

    res.json({ success: true, class: cls });
  } catch (err) {
    console.error("POST /api/classes failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

const VALID_ATTENDANCE_STATUSES = ["present", "partial", "absent"];

// Which Enrollment a completed class should be charged against for one
// student. Exact when the class carries a courseSlug (Class.courseSlug +
// the unique (student, courseSlug) index on Enrollment together make this a
// single, unambiguous document).
//
// Classes created before Class.courseSlug existed have none, so they fall
// back to "the student's only enrollment with this tutor". When that's
// ambiguous — the student holds two courses with the same teacher — this
// returns null and the caller credits nothing. Skipping is the right
// failure here: an uncredited class is visible and fixable, a class charged
// against the wrong course is a wrong number nobody notices, and the
// ambiguity only exists on legacy data that predates the field.
async function findChargeableEnrollment(studentId, classDoc) {
  if (classDoc.courseSlug) {
    return Enrollment.findOne({ student: studentId, courseSlug: classDoc.courseSlug }).select("+perClassCharge");
  }

  const candidates = await Enrollment.find({ student: studentId, tutor: classDoc.tutor })
    .select("+perClassCharge")
    .limit(2);
  return candidates.length === 1 ? candidates[0] : null;
}

// Both money-adjacent effects of a class actually happening, for one present
// student: the teacher's points credit and the student's session decrement.
// They fire from the same completed-class event, against the same resolved
// enrollment, and are deliberately not separable — a class that earned the
// teacher nothing also shouldn't consume a session, and vice versa.
//
// Exactly-once is enforced by TeacherEarning's unique (classId, student)
// index, NOT by endClass's class-level guard. That guard protects the Class
// document and legitimately lets a retry through for a class
// jobs/autoCompleteClasses.js already closed as everyone-absent, so it can't
// be what protects a payout. Here, the ledger insert goes first and acts as
// the claim: whichever concurrent request loses the race gets a duplicate-key
// error, returns without touching anything else, and the decrement below is
// therefore reached exactly once per (class, student) for all time.
//
// A null/absent perClassCharge (a free or trial enrollment) skips both
// effects silently rather than throwing — the class itself completed fine,
// there's just nothing to charge.
async function creditCompletedClass(studentId, classDoc) {
  const enrollment = await findChargeableEnrollment(studentId, classDoc);
  if (!enrollment?.perClassCharge) return;

  const chargedAmount = enrollment.perClassCharge;

  try {
    await TeacherEarning.create({
      // The class's own tutor, not the enrollment's current one. They differ
      // when an admin hands the student to a new tutor between the class
      // being taught and it being ended — and the person who taught it is
      // who gets paid for it. endClass has already verified the caller is
      // this tutor, so it's also the identity that recorded the attendance
      // this credit is based on.
      teacher: classDoc.tutor,
      student: studentId,
      enrollment: enrollment._id,
      classId: classDoc._id,
      courseSlug: enrollment.courseSlug,
      // Snapshot, never a live read of perClassCharge again. A later rate
      // change must not reprice this row — see TeacherEarning.js.
      chargedAmount,
      // Rounded exactly once, here. Nothing downstream recomputes it.
      points: pointsForCharge(chargedAmount),
    });
  } catch (err) {
    // 11000 = the unique (classId, student) index rejecting a retry or a
    // concurrent duplicate. Already credited; returning here is what makes
    // the decrement below non-repeatable too.
    if (err.code === 11000) return;
    throw err;
  }

  // $gt: 0 floors the count at 0 in the query itself rather than in JS — a
  // student who has run out still gets their class taught and their teacher
  // still gets paid, the counter just stops going down.
  await Enrollment.updateOne({ _id: enrollment._id, classesRemaining: { $gt: 0 } }, { $inc: { classesRemaining: -1 } });
}

// Ends a class: records per-student attendance and increments
// completedClassCount for everyone marked "present". Idempotency is the
// critical property here — a double-tap, retry, or two concurrent requests
// must never double-count. Guarded atomically via findOneAndUpdate's status
// filter below, not a read-then-write check in JS, so it holds even if two
// requests for the same class are in flight at the same time.
//
// Also the retroactive-correction path: if jobs/autoCompleteClasses.js
// already closed this class as everyone-absent (attendanceMarkedBy:
// "system"), the tutor can still run End Class once to set real attendance.
// The atomic guard makes that a one-way, one-time transition too, so the
// present-student count increments exactly once here as well.
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

    // Only the request that actually claims the class proceeds past this
    // point — a second call (sequential or concurrent) matches zero
    // documents and falls into the 409 branch below. An "upcoming" class is
    // claimable normally; a "completed" one is claimable only while it's
    // still a system auto-absent record (jobs/autoCompleteClasses.js), which
    // is how a tutor retroactively fixes attendance for a class they never
    // ended in-app. Once the tutor's own attendance is recorded
    // (attendanceMarkedBy: "teacher") the class is final.
    const updatedClass = await Class.findOneAndUpdate(
      { _id: classDoc._id, $or: [{ status: { $ne: "completed" } }, { attendanceMarkedBy: "system" }] },
      {
        $set: {
          status: "completed",
          attendance: attendance.map((entry) => ({ student: entry.studentId, status: entry.status })),
          attendanceMarkedBy: "teacher",
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

      // Sequential rather than Promise.all: each student resolves their own
      // enrollment and writes their own ledger row, and a group class is a
      // handful of students at this scale — no throughput here that's worth
      // parallelising.
      //
      // Isolated per student, and never fatal to the response. By this point
      // the class is already committed as completed with its attendance —
      // the atomic claim above saw to that, and a retry would now 409 — so
      // failing the request would tell the teacher their attendance didn't
      // save when it did. One student's credit failing also mustn't cost
      // the others theirs. A miss is loud in the logs and repairable from
      // the Class document (which student, which class, what attendance),
      // since the ledger's unique index makes re-running a credit safe.
      for (const studentId of presentIds) {
        try {
          await creditCompletedClass(studentId, updatedClass);
        } catch (err) {
          console.error(`TeacherEarning credit failed for class ${updatedClass._id}, student ${studentId}:`, err);
        }
      }
    }

    res.json({ success: true, class: updatedClass });
  } catch (err) {
    console.error("PATCH /api/classes/:id/end failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

const VALID_STATUS_UPDATES = ["cancelled", "postponed"];

// Cancel/postpone — only ever from "upcoming" (a live class is already
// happening; completed/cancelled/postponed are terminal for this endpoint).
// Fires the recipient notification synchronously as part of this request,
// not on the next cron tick — see PART 4 of the phase brief: a
// cancellation/postponement needs to reach people before the class's
// original time, not whenever the reminder job next runs.
export async function updateClassStatus(req, res) {
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

    const { status, scheduledAt } = req.body;
    if (!VALID_STATUS_UPDATES.includes(status)) {
      res.status(400).json({ success: false, message: 'status must be "cancelled" or "postponed".' });
      return;
    }
    if (classDoc.status !== "upcoming") {
      res.status(409).json({ success: false, message: `This class is already ${classDoc.status} and can't be updated.` });
      return;
    }

    // scheduledAt is optional here — postponing without a new time yet is a
    // valid, common case (see notifyClassStatusChange's "to be confirmed"
    // copy). When given, it becomes the class's new scheduledAt right away
    // rather than a separate pending field, so there's still exactly one
    // scheduledAt to reason about everywhere else that reads it.
    let parsedScheduledAt;
    if (scheduledAt !== undefined && scheduledAt !== null && scheduledAt !== "") {
      parsedScheduledAt = new Date(scheduledAt);
      if (Number.isNaN(parsedScheduledAt.getTime())) {
        res.status(400).json({ success: false, message: "Invalid scheduledAt date." });
        return;
      }
    }

    // Keeps the Google Calendar event (if this class has one — a manually
    // --link'd class from scripts/scheduleClass.js may not) from going
    // stale: deleted on cancel, time-patched on a postpone that includes a
    // new scheduledAt. Postponing without a new time yet touches nothing
    // calendar-side, since nothing actually changed. Attempted before the
    // DB write so the calendar and the stored status can't disagree — a
    // failure here is reported back rather than silently cancelling in the
    // app while the meeting still shows live on the calendar.
    if (classDoc.googleCalendarEventId) {
      try {
        if (status === "cancelled") {
          await deleteMeetEvent(classDoc.googleCalendarEventId);
        } else if (status === "postponed" && parsedScheduledAt) {
          await updateMeetEventTime(classDoc.googleCalendarEventId, {
            scheduledAt: parsedScheduledAt,
            durationMinutes: classDoc.durationMinutes,
          });
        }
      } catch (err) {
        console.error(`Google Calendar sync failed for class ${classDoc._id} (${status}):`, err);
        res.status(502).json({ success: false, message: "Could not update the meeting. Please try again." });
        return;
      }
    }

    classDoc.status = status;
    if (parsedScheduledAt) classDoc.scheduledAt = parsedScheduledAt;
    if (status === "cancelled") {
      classDoc.meetingLink = "";
      classDoc.googleCalendarEventId = null;
    }
    await classDoc.save();

    await notifyClassStatusChange(classDoc, { newScheduledAt: parsedScheduledAt });

    res.json({ success: true, class: classDoc });
  } catch (err) {
    console.error("PATCH /api/classes/:id/status failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
