import mongoose from "mongoose";

const EnrollmentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Matches the website's course slugs (data/courses.js: "kannada",
    // "hindi", "telugu") — stored loosely rather than as a foreign key since
    // course content lives in the website repo, not this database.
    courseSlug: { type: String, required: true, trim: true, lowercase: true },
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    batchType: { type: String, enum: ["1-on-1", "group"], default: "1-on-1" },
    status: { type: String, enum: ["active", "paused", "completed"], default: "active" },

    // How many not-yet-attended classes this student has left in the package
    // they already paid for on the website. Decremented server-side by
    // classController.endClass when this student is marked present; only an
    // admin ever credits it, after confirming an off-app payment. This is
    // attendance accounting for sessions bought elsewhere — not a spendable
    // balance and not a currency, which is why the rupee figure it was
    // derived from lives in perClassCharge below and never travels with it.
    // The $gt: 0 guard on the decrement floors it at 0, so a class run "on
    // credit" never pushes it negative.
    classesRemaining: { type: Number, default: 0, min: 0 },

    // Admin-only, per-student (not per-course) rupee rate, set at enrollment
    // time. Two things read it: the admin dashboard, and the credit hook in
    // classController.endClass, which copies it into TeacherEarning.chargedAmount
    // as an immutable snapshot. Whole rupees only — see the validation in
    // adminController.validateMoneyFields; integers end to end keep every
    // downstream sum exact.
    //
    // select: false is load-bearing, not cosmetic: it means an errant
    // .find()/.lean() anywhere in the codebase physically cannot serialise
    // this into a student-facing response. The two places that legitimately
    // need the value opt in explicitly with .select("+perClassCharge").
    // null is a valid, meaningful state — a free or trial enrollment. The
    // credit hook skips both effects for it rather than assuming a rate.
    perClassCharge: { type: Number, select: false, default: null },
  },
  { timestamps: true }
);

// One enrollment per student per course — re-running the admin script for
// the same student+course updates the existing record instead of duplicating.
EnrollmentSchema.index({ student: 1, courseSlug: 1 }, { unique: true });

export default mongoose.models.Enrollment || mongoose.model("Enrollment", EnrollmentSchema);
