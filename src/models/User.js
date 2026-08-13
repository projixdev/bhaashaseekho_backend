import mongoose from "mongoose";

const UserSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, trim: true, unique: true, maxlength: 20 },
    // Delivery channel for OTPs (see authController.sendOtp) and a secondary
    // identifier — phone stays the login identifier. sparse: true means the
    // unique index ignores users who don't have one yet, rather than treating
    // every missing value as a colliding "null".
    email: { type: String, trim: true, lowercase: true, maxlength: 160, unique: true, sparse: true },
    name: { type: String, trim: true, maxlength: 120, default: "" },
    role: { type: String, enum: ["student", "teacher"], default: "student" },

    // OTP is never stored in plaintext — otpHash is an HMAC keyed by
    // env.jwtSecret (see utils/otp.js). otpAttempts guards against brute-force
    // guessing of a live OTP within its expiry window.
    otpHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },
    lastOtpSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Guards against OverwriteModelError if this module is re-evaluated (e.g.
// under --watch) without the process restarting.
export default mongoose.models.User || mongoose.model("User", UserSchema);
