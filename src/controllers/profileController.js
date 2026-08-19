import { connectDB } from "../config/db.js";
import User from "../models/User.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Phone is deliberately not editable here — it's the OTP login identifier
// (authController.sendOtp), changing it is an account-recovery-shaped
// operation, not a profile edit.
export async function updateProfile(req, res) {
  try {
    const { name, email } = req.body;
    const update = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        res.status(400).json({ success: false, message: "Name can't be empty." });
        return;
      }
      update.name = name.trim();
    }

    if (email !== undefined) {
      const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
      if (!EMAIL_RE.test(trimmedEmail)) {
        res.status(400).json({ success: false, message: "Enter a valid email address." });
        return;
      }
      update.email = trimmedEmail;
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ success: false, message: "Nothing to update." });
      return;
    }

    await connectDB();

    let user;
    try {
      user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { returnDocument: "after" });
    } catch (err) {
      // The unique sparse index on email is the real guard — this just
      // turns its duplicate-key error into a clean, readable response
      // instead of a raw Mongo error reaching the client (same pattern as
      // messagesController's Conversation upsert... see feedbackController
      // for the closest precedent: createFeedback's 11000 handling).
      if (err.code === 11000) {
        res.status(409).json({ success: false, message: "That email is already in use." });
        return;
      }
      throw err;
    }

    if (!user) {
      res.status(404).json({ success: false, message: "Account not found." });
      return;
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        email: user.email || "",
        role: user.role,
        isAdmin: user.isAdmin,
        isTrial: user.isTrial,
        notificationsEnabled: user.notificationsEnabled,
      },
    });
  } catch (err) {
    console.error("PATCH /api/profile failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
