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

    // The founder is a teacher account with isAdmin: true, not a separate
    // role (ROADMAP.md "The model (confirmed)"). Nothing distinguished a
    // founder account before Phase 15 — no isAdmin field, env var, or
    // hardcoded check existed anywhere in either repo (confirmed by grep
    // before adding this). Set via scripts/setAdmin.js, never self-serve.
    isAdmin: { type: Boolean, default: false },

    // Soft-delete flag for the admin dashboard's Teacher/Student CRUD
    // (ROADMAP.md admin-dashboard rebuild) — a teacher/student may have
    // Enrollment/Class/Assignment history a hard delete would orphan, so
    // "deleting" one just flips this instead. Deactivated accounts still
    // show up in the admin lists (greyed out), just not selectable for new
    // work. Not currently enforced on login (OTP auth flow is untouched by
    // this phase) — an admin who deactivates someone should also revoke
    // their access another way if that's needed.
    isActive: { type: Boolean, default: true },

    // bcrypt hash, only ever set for isAdmin accounts (ROADMAP.md Phase 17
    // — POST /api/admin/login, for the website dashboard; students/teachers
    // never get one, OTP stays their only login method). select: false so a
    // stray `.find()`/`.lean()` elsewhere in the codebase can never
    // accidentally serialize a hash into a response — POST /api/admin/login
    // explicitly opts in with .select("+password").
    password: { type: String, select: false, maxlength: 100 },

    // Real completion count, written by classController.endClass when a
    // tutor marks a student "present" (ROADMAP.md Phase 13). Drives the
    // assessment unlock gate in assignmentController.js — replaces the old
    // scheduledAt-based stand-in.
    completedClassCount: { type: Number, default: 0 },

    // Set by the website's trial-booking flow (leadsController.postLead,
    // ROADMAP.md Phase 14) — a separate, rate-limited path from admin
    // account creation. accessExpiresAt is only meaningful when isTrial is
    // true; null otherwise.
    isTrial: { type: Boolean, default: false },
    accessExpiresAt: { type: Date, default: null },

    // OTP is never stored in plaintext — otpHash is an HMAC keyed by
    // env.jwtSecret (see utils/otp.js). otpAttempts guards against brute-force
    // guessing of a live OTP within its expiry window.
    otpHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },
    lastOtpSentAt: { type: Date, default: null },

    // Single-device login enforcement — a fresh random id written by
    // authController.verifyOtp on every successful login (never on OTP
    // send), and embedded in that login's JWT. requireAuth rejects any
    // token whose embedded id doesn't match the current value here, which
    // is exactly what makes a new login on device B invalidate device A's
    // still-otherwise-valid 30-day token without needing a server-side
    // revocation list. select: false since it's an internal auth mechanism,
    // not something any route should ever need to return.
    activeSessionId: { type: String, default: null, select: false },

    // Expo push token, registered by the app after login (POST
    // /api/notifications/register-token) — used by the monthly forced-
    // relogin reminder (src/jobs/monthlyReloginReminder.js) and available
    // for other push use later. null until the app has actually asked for
    // notification permission and gotten one back.
    pushToken: { type: String, default: null },
  },
  { timestamps: true }
);

// Guards against OverwriteModelError if this module is re-evaluated (e.g.
// under --watch) without the process restarting.
export default mongoose.models.User || mongoose.model("User", UserSchema);
