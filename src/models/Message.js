import mongoose from "mongoose";

// A conversation only ever has two participants, so "read" is a single
// timestamp (set when the other party fetches it) rather than a per-user
// readBy array — no group chats exist in this app.
const MessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MessageSchema.index({ conversation: 1, createdAt: 1 });

export default mongoose.models.Message || mongoose.model("Message", MessageSchema);
