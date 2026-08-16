import { env } from "../config/env.js";
import { siteMeta, contactDetails, footerCopyright } from "../constants/site.js";

// Table-based layout with inline styles throughout — Outlook desktop (still
// widely used) renders emails with Word's HTML engine, which ignores <style>
// blocks and modern CSS (flexbox/grid) entirely, and doesn't render CSS
// gradients at all (falls back to whatever plain background-color is set
// alongside one) — every gradient below carries an explicit solid
// background-color fallback for that reason, not just decoration.
export function getWhatsAppUrl() {
  const number = env.whatsappNumber;
  return number ? `https://wa.me/${number}` : null;
}

// Gradient button, not a plain fill — matches the header's gradient below.
// Still styled text rather than an image (most clients block remote images
// until the recipient clicks "show images," so an image button would
// render as a broken icon on first open; text always renders immediately).
// #be185d (not the brighter #db2777) specifically because it measures
// 6.04:1 with white text vs. #db2777's borderline 4.60:1 — verified with an
// actual contrast calculation, not eyeballed.
export function emailButton(label, href) {
  return `<a href="${href}" style="display:inline-block; background-color:#4f46e5; background-image:linear-gradient(135deg, #4f46e5 0%, #be185d 100%); color:#ffffff; text-decoration:none; font-weight:bold; font-size:14px; padding:12px 24px; border-radius:8px;">${label}</a>`;
}

// A row of label/value chips (e.g. "INTERESTED IN" / "Kannada") — the
// info-box pattern from the brand refresh reference. items: {label, value}[].
export function emailInfoBox(items) {
  const cells = items
    .map(
      ({ label, value }) => `
        <td width="50%" valign="top" style="padding:14px 16px; background-color:#1e293b; border-radius:8px;">
          <span style="display:block; font-size:11px; font-weight:bold; letter-spacing:0.5px; color:#94a3b8; text-transform:uppercase;">${label}</span>
          <span style="display:block; margin-top:4px; font-size:14px; font-weight:bold; color:#f1f5f9;">${value}</span>
        </td>`
    )
    .join('<td width="8"></td>');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
}

// eyebrow/heading are optional — only the enrollment confirmation email
// uses the "YOU'RE IN" / "Enrollment Received" hero treatment; OTP and
// internal notification emails just get the logo, no hero copy, keeping
// this one layout shared by every email in the system instead of forking a
// second one.
export function renderEmailLayout({ preheader = "", eyebrow, heading, bodyHtml }) {
  const whatsappUrl = getWhatsAppUrl();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${siteMeta.name}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#020617; font-family: Arial, Helvetica, sans-serif;">
    ${preheader ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#020617;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#0f172a; border-radius:16px; overflow:hidden;">
            <tr>
              <td align="center" style="background-color:#4f46e5; background-image:linear-gradient(135deg, #4f46e5 0%, #be185d 100%); padding:${heading ? "36px 32px 40px" : "24px 32px"};">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td valign="middle">
                      <img
                        src="https://res.cloudinary.com/p4uypdeo/image/upload/v1786541401/logo.png"
                        alt="${siteMeta.name}"
                        width="36"
                        height="36"
                        style="display:block; border:0; border-radius:8px;"
                      />
                    </td>
                    <td valign="middle" style="padding-left:12px;">
                      <span style="font-family: Arial, Helvetica, sans-serif; font-size:18px; font-weight:bold; color:#ffffff;">${siteMeta.name}</span>
                    </td>
                  </tr>
                </table>
                ${
                  eyebrow || heading
                    ? `<div style="margin-top:28px;">
                        ${eyebrow ? `<p style="margin:0 0 8px; font-size:12px; font-weight:bold; letter-spacing:1.5px; color:#fce7f3; text-transform:uppercase;">${eyebrow}</p>` : ""}
                        ${heading ? `<p style="margin:0; font-size:26px; font-weight:bold; color:#ffffff;">${heading}</p>` : ""}
                      </div>`
                    : ""
                }
              </td>
            </tr>
            <tr>
              <td style="padding:32px; color:#f1f5f9; font-size:15px; line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="background-color:#020617; padding:24px 32px; border-top:1px solid #1e293b;">
                <span style="font-size:13px; color:#cbd5e1; line-height:1.7;">
                  <strong style="color:#f1f5f9;">${siteMeta.name}</strong><br />
                  ${contactDetails.email} &middot; ${contactDetails.phone}<br />
                  ${whatsappUrl ? `<a href="${whatsappUrl}" style="color:#f472b6; text-decoration:none;">Chat with us on WhatsApp &rarr;</a><br />` : ""}
                  <span style="color:#94a3b8;">${footerCopyright}</span>
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
