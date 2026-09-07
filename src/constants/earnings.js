// The teacher's share of a student's per-class rate, credited as "points"
// (1 point = ₹1 — points are the payout itself, not a separate score).
// Defined once here and imported by the credit hook; it deliberately has no
// second home. Nothing downstream re-derives points from chargedAmount, so
// changing this value affects future classes only and can never retroprice
// a TeacherEarning row that has already been written.
export const TEACHER_EARNING_SHARE = 0.8;

// Whole rupees only, everywhere. Enrollment.perClassCharge is validated
// against this on the way in and TeacherEarning.points is rounded once at
// credit time, which is what keeps every sum below exact — no float ever
// enters a total.
export const MAX_PER_CLASS_CHARGE = 100000;

export function pointsForCharge(chargedAmount) {
  return Math.round(chargedAmount * TEACHER_EARNING_SHARE);
}
