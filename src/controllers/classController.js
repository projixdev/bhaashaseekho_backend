import { connectDB } from "../config/db.js";
import Class from "../models/Class.js";
import Enrollment from "../models/Enrollment.js";
import User from "../models/User.js";
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

    res.json({ success: true, classes });
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
