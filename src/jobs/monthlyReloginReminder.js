import cron from "node-cron";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { sendPushNotifications } from "../services/pushService.js";

// The actual work, separated from the cron wrapper below so it's directly
// callable/testable without fighting node-cron's own scheduling. This is
// only ever a heads-up push — it doesn't itself invalidate anything.
// Enforcement is requireAuth's loginMonth check (authController.js /
// requireAuth.js), which already rejects a stale-month token regardless of
// whether this job ever ran; the push just prompts someone to reopen the
// app sooner rather than waiting to notice on their own.
export async function runMonthlyReloginReminder() {
  await connectDB();

  const users = await User.find({
    role: { $in: ["student", "teacher"] },
    pushToken: { $ne: null },
    notificationsEnabled: { $ne: false },
  })
    .select("pushToken")
    .lean();

  const tokens = users.map((u) => u.pushToken).filter(Boolean);
  if (tokens.length === 0) return { sent: 0 };

  await sendPushNotifications(tokens, {
    title: "Please log in again",
    body: "For your security, your Bhaasha Seekho session resets monthly — open the app and log in again to continue.",
  });

  return { sent: tokens.length };
}

// 00:05 on the 1st of each month, Asia/Kolkata (5 minutes past midnight
// rather than exactly on it, so it isn't the very first thing competing for
// resources right at the stroke of midnight).
export function scheduleMonthlyReloginReminder() {
  cron.schedule(
    "5 0 1 * *",
    () => {
      runMonthlyReloginReminder().catch((err) => console.error("Monthly relogin reminder failed:", err));
    },
    { timezone: "Asia/Kolkata" }
  );
}
