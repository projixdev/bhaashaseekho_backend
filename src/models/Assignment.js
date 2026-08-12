import mongoose from "mongoose";

const AssignmentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["homework", "assessment"], required: true },
    title: { type: String, required: true, trim: true },
    // Tutor's description of what to do — the main content for homework,
    // since homework usually has no file from the tutor. Optional for
    // assessment, where attachmentUrl (the question paper) carries the load.
    instructions: { type: String, default: "", trim: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Whoever assigned it — founder or the student's currently-assigned
    // tutor. Both are just role:"teacher" Users, no special-casing needed.
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Tutor-provided file (mainly assessment question papers) — a Cloudinary
    // URL once file storage is wired up.
    attachmentUrl: { type: String, default: "" },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: ["assigned", "submitted", "reviewed"], default: "assigned" },
    // Student's submission — a photo capture or picked document, uploaded to
    // Cloudinary from the app, then recorded here as a URL.
    submissionUrl: { type: String, default: "" },
    submittedAt: { type: Date, default: null },
    // Free-form for now ("8/10", "Well done") — no grading UI until Teacher
    // UI (Phase 6) exists to set it.
    score: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.models.Assignment || mongoose.model("Assignment", AssignmentSchema);
