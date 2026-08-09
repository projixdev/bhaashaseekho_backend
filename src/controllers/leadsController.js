import { connectDB } from "../config/db.js";
import Lead from "../models/Lead.js";
import { sendTransactionalEmail } from "../services/brevoService.js";
import { isHoneypotTriggered } from "../utils/honeypot.js";
import { validateLeadInput, escapeHtml } from "../utils/validation.js";
import { renderEmailLayout, emailButton, getWhatsAppUrl } from "../services/emailTemplates.js";
import { env } from "../config/env.js";

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

function buildUserConfirmationHtml(body) {
  const whatsappUrl = getWhatsAppUrl();

  const inner = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(body.name)},</p>
    <p style="margin:0 0 20px;">Thanks for your interest in learning ${escapeHtml(body.interest)} with Bhaasha Seekho! We've received your details and our team will reach out to you within 24 hours to help you get started.</p>
    ${whatsappUrl ? `<p style="margin:0 0 8px;">${emailButton("Chat on WhatsApp", whatsappUrl)}</p>` : ""}
    <p style="margin:24px 0 0;">— The Bhaasha Seekho Team</p>
  `;
  return renderEmailLayout({
    preheader: "We've received your details and will be in touch within 24 hours.",
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
          subject: "We've got your details — Bhaasha Seekho",
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
