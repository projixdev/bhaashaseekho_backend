import { connectDB } from "../config/db.js";
import Lead from "../models/Lead.js";
import User from "../models/User.js";
import { sendTransactionalEmail } from "../services/brevoService.js";
import { isHoneypotTriggered } from "../utils/honeypot.js";
import { validateLeadInput, escapeHtml, normalizePhone, PHONE_DIGITS_RE } from "../utils/validation.js";
import { renderEmailLayout, emailButton, getWhatsAppUrl } from "../services/emailTemplates.js";
import { env } from "../config/env.js";

const TRIAL_ACCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

// Creates (or refreshes) a time-limited trial User from a trial-class
// booking — the website's only other way, besides scripts/createUser.js, to
// bring a User record into existence (ROADMAP.md Phase 14). Never touches
// sendOtp's "unenrolled number" rejection: an unknown number is still
// rejected there exactly as before, this just adds a second, separately
// rate-limited path (same "leads" bucket as the rest of this endpoint) by
// which a number stops being unknown.
async function upsertTrialUser({ phone, email, name, trialClassAt }) {
  const normalizedPhone = normalizePhone(phone);
  if (!PHONE_DIGITS_RE.test(normalizedPhone)) return null;

  const existing = await User.findOne({ phone: normalizedPhone });
  if (existing && !existing.isTrial) {
    // Never downgrade a real, already-enrolled account into an expiring
    // trial just because the same phone number re-submitted this form.
    console.warn(`Trial booking skipped — ${normalizedPhone} already belongs to a non-trial account.`);
    return null;
  }

  const user = existing ?? new User({ phone: normalizedPhone, role: "student" });
  user.isTrial = true;
  user.accessExpiresAt = new Date(trialClassAt.getTime() + TRIAL_ACCESS_WINDOW_MS);
  user.email = email;
  if (!user.name) user.name = name;
  await user.save();
  return user;
}

function buildOwnerEmailHtml(body) {
  const inner = `
    <h2 style="margin:0 0 16px; font-size:18px; color:#0f172a;">New lead</h2>
    <p style="margin:0 0 8px;"><strong>Name:</strong> ${escapeHtml(body.name)}</p>
    <p style="margin:0 0 8px;"><strong>Phone:</strong> ${escapeHtml(body.phone)}</p>
    <p style="margin:0 0 8px;"><strong>Email:</strong> ${escapeHtml(body.email || "-")}</p>
    <p style="margin:0 0 8px;"><strong>Interested in:</strong> ${escapeHtml(body.interest)}</p>
    <p style="margin:16px 0 0; font-size:13px; color:#64748b;">UTM: ${escapeHtml(body.utmSource || "-")} /
      ${escapeHtml(body.utmMedium || "-")} / ${escapeHtml(body.utmCampaign || "-")}</p>
  `;
  return renderEmailLayout({ preheader: `New lead: ${body.name} (${body.interest})`, bodyHtml: inner });
}

// Login is phone + emailed OTP, no static password (ROADMAP.md's auth
// decisions) — "login credentials" here means "your phone number is
// enrolled and ready," not a password being generated. Worded to stay
// accurate to that while still matching what the founder asked visitors to
// hear: a concrete 24-hour promise, not a vague "we'll reach out."
function buildUserConfirmationHtml(body) {
  const whatsappUrl = getWhatsAppUrl();

  const inner = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(body.name)},</p>
    <p style="margin:0 0 20px;">Thanks for your interest in learning ${escapeHtml(body.interest)} with Bhaasha Seekho! We've received your details — your demo login will be set up and shared with you within 24 hours.</p>
    <p style="margin:0 0 20px;">Once it's ready, just open the Bhaasha Seekho app and log in with this phone number: <strong>${escapeHtml(body.phone)}</strong>. We'll email you a one-time code each time you log in, so there's no password to remember.</p>
    ${whatsappUrl ? `<p style="margin:0 0 8px;">${emailButton("Chat on WhatsApp", whatsappUrl)}</p>` : ""}
    <p style="margin:24px 0 0;">— The Bhaasha Seekho Team</p>
  `;
  return renderEmailLayout({
    preheader: "Your demo login will be ready within 24 hours.",
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

    // trialClassAt marks this submission as a trial-class booking rather
    // than a general inquiry — same form/endpoint, additive behavior only
    // (ROADMAP.md Phase 14). Validated up front so a malformed trial
    // booking fails fast with a clear 400 instead of silently saving a lead
    // nobody can ever log in to see.
    let trialClassAt = null;
    if (body.trialClassAt) {
      trialClassAt = new Date(body.trialClassAt);
      if (Number.isNaN(trialClassAt.getTime())) {
        res.status(400).json({ success: false, errors: { trialClassAt: "Invalid trial class date/time." } });
        return;
      }
      if (!body.email || typeof body.email !== "string" || !body.email.trim()) {
        res.status(400).json({ success: false, errors: { email: "Email is required to book a trial class." } });
        return;
      }
      if (!PHONE_DIGITS_RE.test(normalizePhone(body.phone))) {
        res.status(400).json({ success: false, errors: { phone: "A valid phone number is required to book a trial class." } });
        return;
      }
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
    });

    // Best-effort, same rationale as the emails below: the lead itself is
    // already safely saved, so a hiccup here shouldn't fail the request —
    // worst case the founder re-runs scripts/createUser.js for this number.
    if (trialClassAt) {
      try {
        await upsertTrialUser({
          phone: body.phone,
          email: body.email.trim().toLowerCase(),
          name: body.name.trim(),
          trialClassAt,
        });
      } catch (trialErr) {
        console.error("Trial user creation failed for lead:", trialErr);
      }
    }

    // Both emails are best-effort: the lead is already safely in MongoDB, so
    // a failed send shouldn't fail the request.
    const notifyEmail = env.clientNotificationEmail;
    if (notifyEmail) {
      try {
        await sendTransactionalEmail({
          to: notifyEmail,
          subject: `New lead: ${body.name} (${body.interest})`,
          htmlContent: buildOwnerEmailHtml(body),
        });
      } catch (ownerErr) {
        console.error("Owner notification failed for lead:", ownerErr);
      }
    }

    // Only the owner notification is guaranteed — the visitor confirmation
    // email requires an email address, which is optional on this form.
    if (body.email) {
      try {
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
