import mongoose from "mongoose";

const ClassSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
    batchType: { type: String, enum: ["1-on-1", "group"], default: "1-on-1" },
    // Which Enrollment this class is actually for. `subject` above is free
    // text a teacher can retitle at will ("Revision — past tense"), so it
    // can't identify a course; and a student may hold two enrollments with
    // the same tutor, so (student, tutor) can't either. That ambiguity is
    // harmless for scheduling but not for money — classController.endClass
    // resolves (student, courseSlug) to exactly one Enrollment via that
    // pair's unique index before charging anything against it.
    //
    // null on classes created before this field existed. endClass falls back
    // to the student's single enrollment with this tutor for those, and
    // skips crediting entirely when that's ambiguous rather than guessing.
    courseSlug: { type: String, trim: true, lowercase: true, default: null },
    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, default: 45 },
    // Zoom/Google Meet link — classes run on those platforms already, no
    // in-app video needed (see ROADMAP.md Phase 4). Google Meet is the
    // current/interim provider (Phase 19); Zoom stays a planned future
    // paid add-on, not replaced by this.
    meetingLink: { type: String, trim: true, default: "" },
    // The Google Calendar event backing meetingLink, when the link was
    // auto-generated via the Calendar API rather than pasted in manually
    // (scripts/scheduleClass.js's --link override leaves this null). Needed
    // to patch/delete that event on reschedule/cancel so the calendar side
    // doesn't go stale once the class itself changes.
    googleCalendarEventId: { type: String, default: null },
    status: { type: String, enum: ["upcoming", "live", "completed", "cancelled", "postponed"], default: "upcoming" },
    // Reminder windows already fired for this class (e.g. ["60min", "30min"])
    // — checked by jobs/classReminders.js before sending, so a cron tick that
    // re-scans an already-notified class (overlap, restart, a missed tick
    // that catches up later) can never double-send. Per-record, unlike the
    // monthly relogin reminder which has nothing to dedupe against.
    notificationsSent: { type: [String], default: [] },
    // Written once, by classController.endClass, when the tutor ends the
    // class. Per-student status (not a plain attended/not-attended boolean)
    // so a future duration-based auto-classification (Zoom integration) has
    // somewhere to put "partial" without a schema migration.
    attendance: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        status: { type: String, enum: ["present", "partial", "absent"], required: true },
      },
    ],
    // Who wrote the attendance array above. null until the class is ended.
    // "teacher" = the tutor ran End Class; "system" = jobs/autoCompleteClasses.js
    // closed the class as everyone-absent after its slot + grace period
    // elapsed with no End Class action. A "system" record is the one
    // completed state endClass will still overwrite — that's how a tutor
    // retroactively corrects attendance for a class they never ended in-app.
    attendanceMarkedBy: { type: String, enum: ["teacher", "system"], default: null },
  },
  { timestamps: true }
);

export default mongoose.models.Class || mongoose.model("Class", ClassSchema);
