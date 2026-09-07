import mongoose from "mongoose";

// Immutable ledger of what a teacher has earned, one row per (class,
// student) pair that was marked present with a priced enrollment. Written
// only by classController.endClass; the only field ever mutated afterwards
// is status/paidAt when an admin settles a batch. Rows are never deleted,
// never repriced, and never recalculated — this is an invoice line, not a
// view over Enrollment.
//
// chargedAmount is a SNAPSHOT of Enrollment.perClassCharge as it stood the
// moment the class was credited, deliberately not a live reference to it.
// An admin editing a student's rate next month must not silently reprice
// classes that already ran, so the rate is copied in here and the ledger
// stops depending on the enrollment for anything but provenance.
const TeacherEarningSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Provenance only — which enrollment's rate this row was derived from.
    // Nothing reads back through it to recompute an amount.
    enrollment: { type: mongoose.Schema.Types.ObjectId, ref: "Enrollment", required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
    courseSlug: { type: String, required: true, trim: true, lowercase: true },
    // Whole rupees. Integers end to end (validated on the way into
    // Enrollment.perClassCharge, rounded once here) so no downstream sum
    // can accumulate float drift.
    chargedAmount: { type: Number, required: true, min: 0 },
    // The teacher's cut, Math.round(chargedAmount * TEACHER_EARNING_SHARE),
    // computed exactly once at credit time. Never re-derived from
    // chargedAmount anywhere downstream — a second derivation with a
    // different share value or rounding would silently disagree with what
    // was actually promised for this class.
    points: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["pending", "paid"], default: "pending" },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// THE idempotency guard for the whole feature. classController.endClass has
// its own atomic class-level claim (only one request can flip a class to
// completed), but that guard protects the Class document, not this
// collection — a retry against a class that was auto-completed by
// jobs/autoCompleteClasses.js is legitimately allowed through it. This index
// is what makes "credit this student for this class" exactly-once regardless
// of how many requests get that far, concurrently or otherwise: the second
// insert fails with a duplicate-key error the caller swallows.
//
// Keyed on (classId, student) rather than (teacher, classId, student): the
// invariant is one credit per student per class, and including teacher would
// let a mid-flight tutor reassignment produce two rows for the same class.
// Group classes are why classId alone can't be unique — one class, many
// students, one row each.
TeacherEarningSchema.index({ classId: 1, student: 1 }, { unique: true });

// Teacher dashboard (their own pending/paid lists) and the admin view
// filtered to one teacher — both read newest-first.
TeacherEarningSchema.index({ teacher: 1, status: 1, createdAt: -1 });

// Admin cross-teacher view, unfiltered or filtered by status only.
TeacherEarningSchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.TeacherEarning || mongoose.model("TeacherEarning", TeacherEarningSchema);
