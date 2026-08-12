import jwt from "jsonwebtoken";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { env } from "../config/env.js";
import { sendOtpSms } from "../services/smsService.js";
import { generateOtp, hashOtp, verifyOtpHash, OTP_TTL_MS, MAX_OTP_ATTEMPTS } from "../utils/otp.js";
import { validatePhoneInput, validateOtpInput, normalizePhone } from "../utils/validation.js";

function signSession(user) {
  return jwt.sign({ sub: user._id.toString(), phone: user.phone, role: user.role }, env.jwtSecret, {
    expiresIn: "30d",
  });
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

    const otp = generateOtp();
    user.otpHash = hashOtp(phone, otp);
    user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    user.otpAttempts = 0;
    user.lastOtpSentAt = new Date();
    await user.save();

    // Best-effort: the OTP is already persisted, so a delivery hiccup
    // shouldn't fail the request — the user can just request a resend.
    try {
      await sendOtpSms(phone, otp);
    } catch (smsErr) {
      console.error("OTP SMS send failed:", smsErr);
    }

    res.json({
      success: true,
      // No SMS provider is wired up yet — surface the code directly outside
      // production so the flow is testable end-to-end. Remove once a real
      // provider is configured.
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

    await connectDB();

    const user = await User.findOne({ phone });
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

    // OTP consumed — clear it so it can't be replayed.
    user.otpHash = null;
    user.otpExpiresAt = null;
    user.otpAttempts = 0;
    await user.save();

    res.json({
      success: true,
      token: signSession(user),
      user: { id: user._id, phone: user.phone, name: user.name, role: user.role },
    });
  } catch (err) {
    console.error("POST /api/auth/verify-otp failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
