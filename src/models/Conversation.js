import mongoose from "mongoose";

// One conversation per tutor-student pair, independent of which/how many
// courses they share (Enrollment can have several rows for the same pair —
// see Enrollment.js) — chat is about the relationship, not a specific
// course. lastMessageAt/lastMessageText are denormalized purely so
// listConversations can render a preview + sort without a second query per
// row.
const ConversationSchema = new mongoose.Schema(
  {
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    lastMessageAt: { type: Date, default: null },
    lastMessageText: { type: String, default: "" },
  },
  { timestamps: true }
);

ConversationSchema.index({ tutor: 1, student: 1 }, { unique: true });

export default mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
