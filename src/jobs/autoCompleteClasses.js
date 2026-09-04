import cron from "node-cron";
import { connectDB } from "../config/db.js";
import Class from "../models/Class.js";

// How long after a class's scheduled end (scheduledAt + durationMinutes) the
// tutor still has to run End Class themselves before the class is auto-closed
// as everyone-absent. Wide enough that a class running a little long, or a
// tutor filling in attendance a few minutes late, is never pre-empted.
const GRACE_PERIOD_MS = 30 * 60 * 1000;

// FUTURE: a separate reconciliation job could pull real join/leave data from
// the Google Admin Reports API (Meet audit logs) and upgrade these
// system-marked "absent" records to actual attendance. Out of scope here —
// this job only covers the "tutor never ran End Class" gap, so a stale class
// stops showing "Start Class" on the home screens instead of lingering.

// The actual work, separate from the cron wrapper below — same split as
// jobs/classReminders.js and jobs/monthlyReloginReminder.js, so it's
// directly callable/testable without fighting node-cron's own scheduling.
// now is injectable for tests; production always passes the real clock.
export async function runAutoCompleteClassesTick(now = new Date()) {
  await connectDB();

  // "upcoming" is the only stale state to worry about: a class the tutor
  // ended is "completed", one they called off is "cancelled"/"postponed",
  // and nothing in the app ever sets "live". The $expr does the "scheduled
  // end + grace has passed" comparison server-side, per-document, because
  // durationMinutes varies per class.
  const candidates = await Class.find({
    status: "upcoming",
    $expr: {
      $lt: [
        { $add: ["$scheduledAt", { $multiply: ["$durationMinutes", 60 * 1000] }, GRACE_PERIOD_MS] },
        now,
      ],
    },
  })
    .select("_id students")
    .lean();

  let completed = 0;
  for (const cls of candidates) {
    // Claims the class atomically before writing attendance — mirrors
    // classController.endClass's idempotency guard. Two overlapping ticks
    // (or a slow tick still running when the next starts) both reach this
    // line for the same class; only the update that actually flips it off
    // "upcoming" returns a document, so it's closed exactly once.
    const claimed = await Class.findOneAndUpdate(
      { _id: cls._id, status: "upcoming" },
      {
        $set: {
          status: "completed",
          attendance: cls.students.map((student) => ({ student, status: "absent" })),
          attendanceMarkedBy: "system",
        },
      },
      { returnDocument: "after" }
    );
    if (!claimed) continue;
    completed += 1;
  }

  return { completed };
}

// Every 15 minutes, Asia/Kolkata (same timezone as the other jobs). Same
// Render free-tier caveat as jobs/monthlyReloginReminder.js: a spun-down
// dyno can't tick, so a class may sit "upcoming" past its grace period until
// the next request wakes the service and the following tick catches it.
export function scheduleAutoCompleteClasses() {
  cron.schedule(
    "*/15 * * * *",
    () => {
      runAutoCompleteClassesTick().catch((err) => console.error("Auto-complete classes tick failed:", err));
    },
    { timezone: "Asia/Kolkata" }
  );
}
