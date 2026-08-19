import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Enrollment from "../models/Enrollment.js";
import { escapeHtml } from "../utils/validation.js";
import { env } from "../config/env.js";

const MAX_MESSAGE_LENGTH = 2000;

function buildSupportEmailHtml({ name, phone, courseLine, message }, { renderEmailLayout, emailInfoBox }) {
  const inner = `
    <h2 style="margin:0 0 16px; font-size:18px; color:#f1f5f9;">New support message</h2>
    ${emailInfoBox([
      { label: "Name", value: escapeHtml(name) },
      { label: "Phone", value: escapeHtml(phone) },
      { label: "Course", value: escapeHtml(courseLine) },
    ])}
    <p style="margin:20px 0 4px;"><strong>Message:</strong></p>
    <p style="margin:0; padding:12px; background-color:#f8fafc; border-radius:6px; color:#334155;">${escapeHtml(message)}</p>
  `;
  return renderEmailLayout({ preheader: `New support message from ${name}`, bodyHtml: inner });
}

// Authenticated counterpart to contactController's public /api/contact —
// that one requires a re-typed name/email since a website visitor isn't
// logged in; this one pulls the sender's identity and enrolled course(s)
// straight from their own account instead of asking for them again. No DB
// record is kept (unlike Contact) — the email itself is the only copy, so
// a failed send is reported back rather than swallowed as best-effort.
//
// brevoService/emailTemplates are imported dynamically below, not
// statically up top, for the same reason classNotifications.js's emailAll
// does it — a static import of brevoService.js from a file that's part of
// app.js's module graph broke auth.test.js's mocked reference to the same
// module (reproduced while building this feature: sendTransactionalEmail
// resolved fine inside authController.js but auth.test.js's own imported
// reference to it still showed zero calls). Deferring both imports to call
// time sidesteps it without touching any working file.
export async function sendSupportMessage(req, res) {
  try {
    const { message } = req.body;
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ success: false, message: "Message is required." });
      return;
    }
    const trimmed = message.trim();
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ success: false, message: "Message is too long." });
      return;
    }

    const notifyEmail = env.clientNotificationEmail;
    if (!notifyEmail) {
      res.status(502).json({ success: false, message: "Support isn't set up yet. Please email us directly." });
      return;
    }

    await connectDB();

    const [user, enrollments] = await Promise.all([
      User.findById(req.user.id).select("name phone email").lean(),
      Enrollment.find({ student: req.user.id }).populate("tutor", "name").lean(),
    ]);

    const courseLine = enrollments.length
      ? enrollments.map((e) => `${e.courseSlug}${e.tutor ? ` (with ${e.tutor.name})` : ""}`).join(", ")
      : "Not enrolled yet";

    const [{ sendTransactionalEmail }, emailTemplates] = await Promise.all([
      import("../services/brevoService.js"),
      import("../services/emailTemplates.js"),
    ]);

    await sendTransactionalEmail({
      to: notifyEmail,
      subject: `Support message from ${user?.name || "a student"}`,
      htmlContent: buildSupportEmailHtml(
        { name: user?.name || "Unknown", phone: user?.phone || "—", courseLine, message: trimmed },
        emailTemplates
      ),
      replyTo: user?.email || undefined,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/support failed:", err);
    res.status(502).json({ success: false, message: "Message could not be sent. Please try emailing us directly." });
  }
}
