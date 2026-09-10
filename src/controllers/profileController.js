import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { env } from "../config/env.js";
import { escapeHtml } from "../utils/validation.js";
import { normalizeTimezone } from "../utils/timezone.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Days the app promises the user their data will be gone within — kept here
// so the copy the API implies and the copy the app shows stay one value.
export const ACCOUNT_DELETION_WINDOW_DAYS = 7;

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

    // Device IANA zone (see authController.applyTimezone) — the app can send
    // it on a profile save too, not just at login. Ignored if not a real
    // zone rather than 400'd, same as the login path.
    if (req.body.timezone !== undefined) {
      const tz = normalizeTimezone(req.body.timezone);
      if (tz) update.timezone = tz;
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
        accessExpiresAt: user.accessExpiresAt,
        notificationsEnabled: user.notificationsEnabled,
        timezone: user.timezone,
      },
    });
  } catch (err) {
    console.error("PATCH /api/profile failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

function buildDeletionEmailHtml({ name, phone, email, role, userId }, { renderEmailLayout, emailInfoBox }) {
  const inner = `
    <h2 style="margin:0 0 16px; font-size:18px; color:#f1f5f9;">Account deletion request</h2>
    <p style="margin:0 0 16px; color:#cbd5e1;">
      This user asked to delete their account from the app. Their session is already
      revoked and they can't log back in. Purge their personal data within
      ${ACCOUNT_DELETION_WINDOW_DAYS} days.
    </p>
    ${emailInfoBox([
      { label: "Name", value: escapeHtml(name) },
      { label: "Phone", value: escapeHtml(phone) },
      { label: "Email", value: escapeHtml(email) },
      { label: "Role", value: escapeHtml(role) },
      { label: "User ID", value: escapeHtml(userId) },
    ])}
  `;
  return renderEmailLayout({ preheader: `Account deletion request from ${name}`, bodyHtml: inner });
}

// Apple Guideline 5.1.1(v): a user must be able to delete their account from
// within the app, without being told to email support. This is
// request-based — the account is made unusable immediately here (session
// killed, re-login refused via authController's deletionRequestedAt checks),
// and the actual PII purge is a manual team step within the disclosed
// window. That's acceptable for a paid service with financial/attendance
// records a hard delete would orphan (TeacherEarning is deliberately
// immutable; class history has referential integrity).
export async function requestAccountDeletion(req, res) {
  try {
    await connectDB();

    const user = await User.findById(req.user.id).select("+activeSessionId name phone email role deletionRequestedAt");
    if (!user) {
      res.status(404).json({ success: false, message: "Account not found." });
      return;
    }

    // Idempotent — a repeat tap, retry, or stale client must not 500 or fire
    // a second team email.
    if (user.deletionRequestedAt) {
      res.json({ success: true });
      return;
    }

    user.deletionRequestedAt = new Date();
    user.isActive = false;
    user.activeSessionId = null; // requireAuth 401s the current token on its next request
    user.pushToken = null; // stop all push immediately
    await user.save();

    // Team notification so the purge actually happens — best-effort, the
    // request already succeeded above and a mail hiccup mustn't undo it.
    const notifyEmail = env.clientNotificationEmail;
    if (notifyEmail) {
      try {
        const [{ sendTransactionalEmail }, emailTemplates] = await Promise.all([
          import("../services/brevoService.js"),
          import("../services/emailTemplates.js"),
        ]);
        await sendTransactionalEmail({
          to: notifyEmail,
          subject: `Account deletion request — ${user.name || user.phone}`,
          htmlContent: buildDeletionEmailHtml(
            {
              name: user.name || "—",
              phone: user.phone,
              email: user.email || "—",
              role: user.role,
              userId: user._id.toString(),
            },
            emailTemplates
          ),
        });
      } catch (mailErr) {
        console.error("Account-deletion team email failed:", mailErr);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/profile/deletion-request failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
