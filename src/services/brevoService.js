import { env } from "../config/env.js";

// Calls Brevo's transactional email REST API directly (no SDK dependency).
export async function sendTransactionalEmail({ to, subject, htmlContent, replyTo }) {
  const apiKey = env.brevoApiKey;
  const senderEmail = env.brevoSenderEmail;

  if (!apiKey || !senderEmail) {
    throw new Error("Brevo is not configured (missing BREVO_API_KEY / BREVO_SENDER_EMAIL)");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: "Bhaasha Seekho" },
      to: [{ email: to }],
      subject,
      htmlContent,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brevo API error ${response.status}: ${errorText}`);
  }

  return response.json();
}
