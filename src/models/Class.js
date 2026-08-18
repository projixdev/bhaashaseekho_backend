import mongoose from "mongoose";

const ClassSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
    batchType: { type: String, enum: ["1-on-1", "group"], default: "1-on-1" },
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
  },
  { timestamps: true }
);

export default mongoose.models.Class || mongoose.model("Class", ClassSchema);
