import crypto from "node:crypto";
import { env } from "../config/env.js";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const MAX_OTP_ATTEMPTS = 5;

export function generateOtp() {
  // Uniform 6-digit code, no leading-zero bias from Math.random().
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// HMAC keyed by the server's JWT secret rather than a separate OTP secret —
// one fewer env var to configure, and the two purposes (session signing,
// OTP integrity) don't need independent key rotation for a v1.
export function hashOtp(phone, otp) {
  return crypto.createHmac("sha256", env.jwtSecret).update(`otp:${phone}:${otp}`).digest("hex");
}

export function verifyOtpHash(phone, otp, expectedHash) {
  const actualHash = Buffer.from(hashOtp(phone, otp));
  const expected = Buffer.from(expectedHash);
  if (actualHash.length !== expected.length) return false;
  return crypto.timingSafeEqual(actualHash, expected);
}
