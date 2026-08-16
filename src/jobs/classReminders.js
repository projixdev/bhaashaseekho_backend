import cron from "node-cron";
import { connectDB } from "../config/db.js";
import Class from "../models/Class.js";
import { notifyClassStarting } from "../services/classNotifications.js";

const REMINDER_WINDOWS = [
  { key: "60min", minutesBefore: 60 },
  { key: "30min", minutesBefore: 30 },
];

// How far off "exactly N minutes before" a class's scheduledAt is still
// allowed to be and still count as inside that reminder's window. A tick
// runs every minute (see scheduleClassReminders), so this only needs to be
// wide enough to survive a delayed/skipped tick (Render free-tier spin-down,
// a slow previous tick still finishing) — notificationsSent, not this
// window, is what actually prevents a duplicate send.
const TOLERANCE_MS = 2 * 60 * 1000;

// The actual work, separate from the cron wrapper below — same split as
// jobs/monthlyReloginReminder.js, for the same reason (directly callable/
// testable without fighting node-cron's own scheduling). now is injectable
// for tests; production calls always use the real clock.
export async function runClassReminderTick(now = new Date()) {
  await connectDB();

  let sent = 0;
  for (const { key, minutesBefore } of REMINDER_WINDOWS) {
    const target = new Date(now.getTime() + minutesBefore * 60 * 1000);
    const windowStart = new Date(target.getTime() - TOLERANCE_MS);
    const windowEnd = new Date(target.getTime() + TOLERANCE_MS);

    // Only "upcoming" classes are ever candidates — a class that's since
    // been cancelled or postponed simply stops matching this query from
    // then on, which is what makes a pending 60/30-min reminder for it
    // silently suppressed rather than needing a separate check.
    const candidates = await Class.find({
      status: "upcoming",
      scheduledAt: { $gte: windowStart, $lte: windowEnd },
      notificationsSent: { $ne: key },
    })
      .select("_id")
      .lean();

    for (const { _id } of candidates) {
      // Claims this class+window atomically before sending — mirrors
      // classController.endClass's idempotency guard. Two overlapping ticks
      // (or a slow tick still running when the next one starts) both reach
      // this line for the same class; only the update that actually flips
      // notificationsSent returns a document, so only one of them proceeds
      // to send.
      const claimed = await Class.findOneAndUpdate(
        { _id, notificationsSent: { $ne: key } },
        { $addToSet: { notificationsSent: key } },
        { returnDocument: "after" }
      );
      if (!claimed) continue;

      await notifyClassStarting(claimed, minutesBefore).catch((err) =>
        console.error(`Class reminder (${key}) failed for class ${_id}:`, err)
      );
      sent += 1;
    }
  }

  return { sent };
}

export function scheduleClassReminders() {
  cron.schedule(
    "* * * * *",
    () => {
      runClassReminderTick().catch((err) => console.error("Class reminder tick failed:", err));
    },
    { timezone: "Asia/Kolkata" }
  );
}
