import { connectDB } from "../config/db.js";
import Lead from "../models/Lead.js";
import { isValidCourseSlug } from "../utils/courseTaxonomy.js";
import { isHoneypotTriggered } from "../utils/honeypot.js";
import { validateLeadInput, escapeHtml } from "../utils/validation.js";
import { renderEmailLayout, emailButton, emailInfoBox, getWhatsAppUrl } from "../services/emailTemplates.js";
import { env } from "../config/env.js";

function buildOwnerEmailHtml(body, isCourseRequest) {
  const heading = isCourseRequest ? "Course request from an existing student" : "New lead";
  const inner = `
    <h2 style="margin:0 0 16px; font-size:18px; color:#f1f5f9;">${escapeHtml(heading)}</h2>
    <p style="margin:0 0 8px;"><strong>Name:</strong> ${escapeHtml(body.name)}</p>
    <p style="margin:0 0 8px;"><strong>Phone:</strong> ${escapeHtml(body.phone)}</p>
    <p style="margin:0 0 8px;"><strong>Email:</strong> ${escapeHtml(body.email || "-")}</p>
    <p style="margin:0 0 8px;"><strong>Interested in:</strong> ${escapeHtml(body.interest)}</p>
    ${
      isCourseRequest
        ? `<p style="margin:0 0 8px;"><strong>This student already has an account</strong> — enroll them in this course from the admin dashboard rather than creating a new one.</p>`
        : ""
    }
    <p style="margin:16px 0 0; font-size:13px; color:#94a3b8;">UTM: ${escapeHtml(body.utmSource || "-")} /
      ${escapeHtml(body.utmMedium || "-")} / ${escapeHtml(body.utmCampaign || "-")}</p>
  `;
  return renderEmailLayout({ preheader: `${heading}: ${body.name} (${body.interest})`, bodyHtml: inner });
}

// Login is phone + emailed OTP, no static password (ROADMAP.md's auth
// decisions) — "login credentials" here means "your phone number is
// enrolled and ready," not a password being generated. Worded to stay
// accurate to that while still matching what the founder asked visitors to
// hear: a concrete 24-hour promise, not a vague "we'll reach out." The info
// box shows what we actually have at this stage (interest + phone) — no
// start date/batch mode exists yet, since those are set later when an
// admin creates the real account.
function buildUserConfirmationHtml(body) {
  const whatsappUrl = getWhatsAppUrl();

  const inner = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(body.name)}, thanks for your interest in learning with Bhaasha Seekho! We've received your details — your demo login will be set up and shared with you within 24 hours.</p>
    ${emailInfoBox([
      { label: "Interested in", value: escapeHtml(body.interest) },
      { label: "Contact number", value: escapeHtml(body.phone) },
    ])}
    <p style="margin:24px 0 20px;">Once it's ready, just open the Bhaasha Seekho app and log in with the phone number above. We'll email you a one-time code each time you log in, so there's no password to remember.</p>
    ${whatsappUrl ? `<p style="margin:0 0 8px;">${emailButton("Chat on WhatsApp", whatsappUrl)}</p>` : ""}
    <p style="margin:24px 0 0;">— The Bhaasha Seekho Team</p>
  `;
  return renderEmailLayout({
    preheader: "Your demo login will be ready within 24 hours.",
    eyebrow: "You're in",
    heading: "Enrollment Received",
    bodyHtml: inner,
  });
}

export async function postLead(req, res) {
  try {
    const body = req.body;

    if (isHoneypotTriggered(body.honeypot)) {
      // Silently pretend success so the bot doesn't learn it was caught —
      // no DB write, no email.
      res.json({ success: true });
      return;
    }

    const { valid, errors } = validateLeadInput(body);
    if (!valid) {
      res.status(400).json({ success: false, errors });
      return;
    }

    // Set only by the app's authenticated "Request this course" flow
    // (optionalAuth) — never trusted from the request body itself, so a
    // public website submission can't forge an association with someone
    // else's account.
    const isCourseRequest = Boolean(req.user && body.courseSlug);
    if (isCourseRequest && !isValidCourseSlug(String(body.courseSlug).trim().toLowerCase())) {
      res.status(400).json({ success: false, errors: { courseSlug: "Unknown courseSlug." } });
      return;
    }

    // Saving the lead is the critical path — if this fails, the request
    // fails, because the lead is genuinely lost otherwise.
    await connectDB();
    await Lead.create({
      name: body.name.trim(),
      phone: body.phone.trim(),
      email: (body.email || "").trim().toLowerCase(),
      interest: body.interest.trim(),
      utmSource: (body.utmSource || "").trim(),
      utmMedium: (body.utmMedium || "").trim(),
      utmCampaign: (body.utmCampaign || "").trim(),
      courseSlug: isCourseRequest ? String(body.courseSlug).trim().toLowerCase() : "",
      userId: isCourseRequest ? req.user.id : null,
    });

    // Both emails are best-effort: the lead is already safely in MongoDB, so
    // a failed send shouldn't fail the request. sendTransactionalEmail is
    // imported dynamically (call time, not top-level) — the same fix
    // supportController.js uses: a static top-level import of brevoService.js
    // from a file in app.js's module graph previously broke an unrelated
    // test file's mocked reference to the same module (see supportController
    // .js's comment for the full story).
    const notifyEmail = env.clientNotificationEmail;
    if (notifyEmail) {
      try {
        const { sendTransactionalEmail } = await import("../services/brevoService.js");
        await sendTransactionalEmail({
          to: notifyEmail,
          subject: `${isCourseRequest ? "Course request" : "New lead"}: ${body.name} (${body.interest})`,
          htmlContent: buildOwnerEmailHtml(body, isCourseRequest),
        });
      } catch (ownerErr) {
        console.error("Owner notification failed for lead:", ownerErr);
      }
    }

    // The "your demo login is on its way" copy only makes sense for a
    // brand-new visitor — an existing, already-logged-in student requesting
    // another course gets its own in-app confirmation instead (see the
    // app's course-request screen), so skip this email for that case.
    if (body.email && !isCourseRequest) {
      try {
        const { sendTransactionalEmail } = await import("../services/brevoService.js");
        await sendTransactionalEmail({
          to: body.email,
          subject: "Your demo login is on its way — Bhaasha Seekho",
          htmlContent: buildUserConfirmationHtml(body),
        });
      } catch (confirmErr) {
        console.error("Lead confirmation email failed:", confirmErr);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/leads failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
