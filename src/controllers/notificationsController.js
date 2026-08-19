import { connectDB } from "../config/db.js";
import User from "../models/User.js";

// Called once the app has actually been granted notification permission and
// obtained an Expo push token — re-sent on every login too (a fresh
// install/reinstall can get a new token for the same account), so this is
// an upsert-style overwrite, not a one-time write.
export async function registerPushToken(req, res) {
  try {
    const { pushToken } = req.body;
    if (typeof pushToken !== "string" || !pushToken.trim()) {
      res.status(400).json({ success: false, message: "pushToken is required." });
      return;
    }

    await connectDB();
    await User.findByIdAndUpdate(req.user.id, { $set: { pushToken: pushToken.trim() } });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/notifications/register-token failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// The app's Profile screen toggle — doesn't touch pushToken itself (a
// re-enable shouldn't require re-registering), every push-sending path
// just checks this flag alongside pushToken before sending.
export async function updateNotificationPreferences(req, res) {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ success: false, message: "enabled must be true or false." });
      return;
    }

    await connectDB();
    await User.findByIdAndUpdate(req.user.id, { $set: { notificationsEnabled: enabled } });

    res.json({ success: true, notificationsEnabled: enabled });
  } catch (err) {
    console.error("PATCH /api/notifications/preferences failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
