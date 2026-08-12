// No SMS provider is configured yet (no MSG91/Twilio credentials in env).
// Logs the OTP server-side so the auth flow is testable end-to-end without
// one; swap the body for a real provider call when one is wired up — the
// call site (authController) doesn't need to change.
export async function sendOtpSms(phone, otp) {
  console.log(`[OTP] ${phone}: ${otp}`);
}
