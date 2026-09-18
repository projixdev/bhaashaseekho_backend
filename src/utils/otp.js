import crypto from "node:crypto";
import { env } from "../config/env.js";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const MAX_OTP_ATTEMPTS = 5;

// Minimum gap between two OTP sends for the *same account*, enforced by
// authController.sendOtp against User.lastOtpSentAt. Lives here next to the
// other OTP tunables rather than in the controller so the whole OTP policy
// (lifetime, guess budget, resend gap) is readable in one place.
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

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

// Constant-time comparison for the reviewer/demo-account bypass (see
// authController.js — covers both Play Store and App Store review
// accounts, one shared OTP for every configured phone). Not a hash like
// verifyOtpHash -- REVIEWER_TEST_OTP is
// a fixed, operator-configured value -- but still worth comparing without a
// timing side-channel, since it's a real (if narrowly-scoped) login
// credential once configured.
export function verifyReviewerOtp(submitted, expected) {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
