import mongoose from "mongoose";

const FeedbackSchema = new mongoose.Schema(
  {
    class: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Denormalized from the class at write time (classController.endClass
    // is the only writer of Class.tutor) so the founder's feed doesn't need
    // a join to show who taught it.
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sentiment: { type: String, enum: ["agree", "disagree"], required: true },
    comment: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

// One feedback submission per student per class — no duplicates.
FeedbackSchema.index({ class: 1, student: 1 }, { unique: true });

export default mongoose.models.Feedback || mongoose.model("Feedback", FeedbackSchema);
