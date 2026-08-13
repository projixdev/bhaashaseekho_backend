import mongoose from "mongoose";

const ClassSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
    batchType: { type: String, enum: ["1-on-1", "group"], default: "1-on-1" },
    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, default: 45 },
    // Zoom/Google Meet link — classes run on those platforms already, no
    // in-app video needed (see ROADMAP.md Phase 4).
    meetingLink: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["upcoming", "live", "completed", "cancelled"], default: "upcoming" },
    // Written once, by classController.endClass, when the tutor ends the
    // class. Per-student status (not a plain attended/not-attended boolean)
    // so a future duration-based auto-classification (Zoom integration) has
    // somewhere to put "partial" without a schema migration.
    attendance: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        status: { type: String, enum: ["present", "partial", "absent"], required: true },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.models.Class || mongoose.model("Class", ClassSchema);
