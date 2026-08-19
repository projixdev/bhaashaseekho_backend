import crypto from "crypto";
import jwt from "jsonwebtoken";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { env } from "../config/env.js";
import { sendTransactionalEmail } from "../services/brevoService.js";
import { renderEmailLayout } from "../services/emailTemplates.js";
import { generateOtp, hashOtp, verifyOtpHash, OTP_TTL_MS, MAX_OTP_ATTEMPTS } from "../utils/otp.js";
import { validatePhoneInput, validateOtpInput, normalizePhone } from "../utils/validation.js";
import { currentMonthKey } from "../utils/sessionMonth.js";

// sessionId is required (not optional/defaulted here) — the caller must
// always pass the value it just wrote to user.activeSessionId, so the two
// can never silently drift apart.
function signSession(user, sessionId) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      phone: user.phone,
      role: user.role,
      isAdmin: user.isAdmin,
      isTrial: user.isTrial,
      // ISO string, not a raw Date — JWT payloads are JSON, and comparing
      // this against Date.now() on every request (requireAuth) is how a
      // trial's natural expiry is caught even on an already-issued,
      // otherwise-still-valid token.
      accessExpiresAt: user.accessExpiresAt ? user.accessExpiresAt.toISOString() : null,
      // Single-device enforcement (requireAuth compares this against
      // User.activeSessionId) and forced monthly re-login (requireAuth
      // compares this against the current calendar month) — both are
      // "teachers and students" features, deliberately absent from the
      // separate admin password-login token (adminController.adminLogin).
      sessionId,
      loginMonth: currentMonthKey(),
    },
    env.jwtSecret,
    { expiresIn: "30d" }
  );
}

function isTrialExpired(user) {
  return Boolean(user.isTrial && user.accessExpiresAt && user.accessExpiresAt.getTime() < Date.now());
}

// Masked server-side, not client-side — the raw email never goes over the
// wire at all, not even to a trusted client. Fixed "***" (not proportional
// to local-part length) so the result stays visually consistent regardless
// of how long the address is.
function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!domain || local.length === 0) return email;
  return `${local[0]}***@${domain}`;
}

// Reuses the shared Brevo layout (services/emailTemplates.js) — same
// branding as the lead/contact notification emails, just a different body.
function buildOtpEmailHtml(otp) {
  const minutes = Math.round(OTP_TTL_MS / 60000);
  const inner = `
    <p style="margin:0 0 16px;">Your login code is:</p>
    <p style="margin:0 0 20px; font-size:28px; font-weight:bold; letter-spacing:4px; color:#ffffff;">${otp}</p>
    <p style="margin:0; color:#94a3b8; font-size:13px;">Valid for ${minutes} minutes. Don't share this code with anyone.</p>
  `;
  return renderEmailLayout({ preheader: `Your login code: ${otp}`, bodyHtml: inner });
}

export async function sendOtp(req, res) {
  try {
    const { valid, errors } = validatePhoneInput(req.body);
    if (!valid) {
      res.status(400).json({ success: false, errors });
      return;
    }

    const phone = normalizePhone(req.body.phone);

    await connectDB();

    const user = await User.findOne({ phone });
    if (!user) {
      // Accounts are never self-created: students are activated by admin
      // after enrolling on the website, teachers are created by admin
      // directly (see scripts/createUser.js). An unknown number means
      // neither has happened yet.
      res.status(404).json({
        success: false,
        message: "This number isn't enrolled yet. Please enroll on our website first.",
      });
      return;
    }

    // Distinct from the "not enrolled" case above — this is a real account
    // whose time-limited window has simply passed (ROADMAP.md Phase 14).
    // Kept as its own message rather than collapsed into either the
    // not-enrolled or no-email cases, which mean different things to a user.
    if (isTrialExpired(user)) {
      res.status(403).json({ success: false, message: "Your trial access has expired." });
      return;
    }

    // OTP delivery is email-only (ROADMAP.md Phase 16) — without one on file
    // there's nowhere to send the code, so fail before generating one rather
    // than persisting an OTP nobody can ever retrieve.
    if (!user.email) {
      res.status(400).json({
        success: false,
        message: "No email on file — contact admin to add one.",
      });
      return;
    }

    const otp = generateOtp();
    user.otpHash = hashOtp(phone, otp);
    user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    user.otpAttempts = 0;
    user.lastOtpSentAt = new Date();
    await user.save();

    // Best-effort: the OTP is already persisted, so a delivery hiccup
    // shouldn't fail the request — the user can just request a resend.
    try {
      await sendTransactionalEmail({
        to: user.email,
        subject: "Your Bhaasha Seekho login code",
        htmlContent: buildOtpEmailHtml(otp),
      });
    } catch (emailErr) {
      console.error("OTP email send failed:", emailErr);
    }

    res.json({
      success: true,
      // Lets the app confirm where the code went (login.tsx, ROADMAP.md
      // login-screen polish) — masked, see maskEmail above.
      email: maskEmail(user.email),
      // devOtp keeps local/dev testing independent of Brevo actually
      // delivering — surfaced only outside production. Remove once email
      // delivery is proven reliable enough to depend on exclusively.
      ...(env.nodeEnv !== "production" ? { devOtp: otp } : {}),
    });
  } catch (err) {
    console.error("POST /api/auth/send-otp failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function verifyOtp(req, res) {
  try {
    const { valid, errors } = validateOtpInput(req.body);
    if (!valid) {
      res.status(400).json({ success: false, errors });
      return;
    }

    const phone = normalizePhone(req.body.phone);
    const otp = req.body.otp.trim();
    const forceLogout = req.body.forceLogout === true;

    await connectDB();

    const user = await User.findOne({ phone }).select("+activeSessionId");
    if (!user || !user.otpHash || !user.otpExpiresAt) {
      res.status(400).json({ success: false, message: "Request a new code first." });
      return;
    }

    if (user.otpExpiresAt.getTime() < Date.now()) {
      res.status(400).json({ success: false, message: "Code expired. Request a new one." });
      return;
    }

    if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
      res.status(429).json({ success: false, message: "Too many attempts. Request a new code." });
      return;
    }

    if (!verifyOtpHash(phone, otp, user.otpHash)) {
      user.otpAttempts += 1;
      await user.save();
      res.status(400).json({ success: false, message: "Incorrect code." });
      return;
    }

    // Correct code, but this account is already logged in elsewhere and the
    // client hasn't confirmed the takeover yet — don't consume the OTP
    // (leave it valid) so the confirmation round-trip doesn't force the
    // visitor to request and re-enter a brand new code just to say yes.
    if (user.activeSessionId && !forceLogout) {
      res.status(409).json({
        success: false,
        requiresForceLogout: true,
        message: "This account is already logged in on another device. Log out that device and continue here?",
      });
      return;
    }

    // OTP consumed — clear it so it can't be replayed. A fresh sessionId is
    // written (and embedded in the token below) unconditionally, which is
    // exactly what invalidates a previous device's session on the very next
    // request it makes through requireAuth, whether or not one existed.
    const sessionId = crypto.randomUUID();
    user.otpHash = null;
    user.otpExpiresAt = null;
    user.otpAttempts = 0;
    user.activeSessionId = sessionId;
    await user.save();

    res.json({
      success: true,
      token: signSession(user, sessionId),
      user: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        email: user.email || "",
        role: user.role,
        isAdmin: user.isAdmin,
        isTrial: user.isTrial,
        notificationsEnabled: user.notificationsEnabled,
      },
    });
  } catch (err) {
    console.error("POST /api/auth/verify-otp failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
