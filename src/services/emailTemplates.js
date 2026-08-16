import { env } from "../config/env.js";
import { siteMeta, contactDetails, footerCopyright } from "../constants/site.js";

// Table-based layout with inline styles throughout — Outlook desktop (still
// widely used) renders emails with Word's HTML engine, which ignores <style>
// blocks and modern CSS (flexbox/grid) entirely. This is the email-safe
// subset.
export function getWhatsAppUrl() {
  const number = env.whatsappNumber;
  return number ? `https://wa.me/${number}` : null;
}

// Styled text, not a logo image: most clients block remote images until the
// recipient clicks "show images," so an image logo would render as a broken
// icon on first open. Text always renders immediately.
export function emailButton(label, href) {
  return `<a href="${href}" style="display:inline-block; background-color:#b45309; color:#ffffff; text-decoration:none; font-weight:bold; font-size:14px; padding:12px 24px; border-radius:6px;">${label}</a>`;
}

export function renderEmailLayout({ preheader = "", bodyHtml }) {
  const whatsappUrl = getWhatsAppUrl();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${siteMeta.name}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f8fafc; font-family: Arial, Helvetica, sans-serif;">
    ${preheader ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e2e8f0;">
            <tr>
              <td style="background-color:#0f172a; padding:20px 32px;">
                <!-- Logo image + text side by side, not image-only: if the
                     client blocks remote images (common on first open), the
                     alt text and the adjacent <span> both still render the
                     brand name immediately, same reasoning as emailButton
                     below just applied to the header instead of dropping
                     the image entirely. -->
                <img
                  src="https://res.cloudinary.com/p4uypdeo/image/upload/v1786541401/logo.png"
                  alt="${siteMeta.name}"
                  width="40"
                  height="40"
                  style="display:inline-block; vertical-align:middle; border:0; border-radius:8px;"
                />
                <span style="display:inline-block; vertical-align:middle; margin-left:12px; font-family: Arial, Helvetica, sans-serif; font-size:20px; font-weight:bold; color:#ffffff;">Bhaasha Seekho</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px; color:#0f172a; font-size:15px; line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="background-color:#f8fafc; padding:24px 32px; border-top:1px solid #e2e8f0;">
                <span style="font-size:13px; color:#334155; line-height:1.7;">
                  <strong style="color:#0f172a;">${siteMeta.name}</strong><br />
                  ${contactDetails.email} &middot; ${contactDetails.phone}<br />
                  ${whatsappUrl ? `<a href="${whatsappUrl}" style="color:#b45309; text-decoration:none;">Chat with us on WhatsApp &rarr;</a><br />` : ""}
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
