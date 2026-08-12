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
  },
  { timestamps: true }
);

// One enrollment per student per course — re-running the admin script for
// the same student+course updates the existing record instead of duplicating.
EnrollmentSchema.index({ student: 1, courseSlug: 1 }, { unique: true });

export default mongoose.models.Enrollment || mongoose.model("Enrollment", EnrollmentSchema);
