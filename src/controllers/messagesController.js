import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Enrollment from "../models/Enrollment.js";
import User from "../models/User.js";
import { sendPushNotifications } from "../services/pushService.js";

const PAGE_SIZE = 50;
const MAX_TEXT_LENGTH = 2000;

// A teacher may only message a student on their own roster; a student may
// only message a tutor they're actually enrolled with (Enrollment.tutor can
// be null for a not-yet-assigned enrollment — excluded). Returns the pair
// shaped exactly like Conversation's schema fields, ready to spread into a
// query or upsert, or null if no such relationship exists.
async function resolveCounterpart(req, otherUserId) {
  if (req.user.role === "teacher") {
    const enrollment = await Enrollment.findOne({ tutor: req.user.id, student: otherUserId });
    return enrollment ? { tutor: req.user.id, student: otherUserId } : null;
  }
  const enrollment = await Enrollment.findOne({ student: req.user.id, tutor: otherUserId });
  return enrollment ? { tutor: otherUserId, student: req.user.id } : null;
}

// Every enrolled counterpart is chat-reachable, not just ones with an
// existing Conversation doc — mirrors rosterController's scoping, so a
// teacher/student can start a chat with anyone on their roster without a
// separate "new conversation" step. Conversation docs are created lazily on
// first send (see sendMessage).
export async function listConversations(req, res) {
  try {
    await connectDB();

    const enrollments =
      req.user.role === "teacher"
        ? await Enrollment.find({ tutor: req.user.id }).populate("student", "name phone").lean()
        : await Enrollment.find({ student: req.user.id, tutor: { $ne: null } }).populate("tutor", "name phone").lean();

    const counterpartsById = new Map();
    for (const e of enrollments) {
      const counterpart = req.user.role === "teacher" ? e.student : e.tutor;
      if (counterpart) counterpartsById.set(counterpart._id.toString(), counterpart);
    }

    const conversations = await Promise.all(
      [...counterpartsById.entries()].map(async ([otherUserId, counterpart]) => {
        const query =
          req.user.role === "teacher"
            ? { tutor: req.user.id, student: otherUserId }
            : { tutor: otherUserId, student: req.user.id };
        const conversation = await Conversation.findOne(query).lean();
        const unreadCount = conversation
          ? await Message.countDocuments({ conversation: conversation._id, sender: { $ne: req.user.id }, readAt: null })
          : 0;

        return {
          otherUserId,
          name: counterpart.name,
          phone: counterpart.phone,
          lastMessageText: conversation?.lastMessageText ?? "",
          lastMessageAt: conversation?.lastMessageAt ?? null,
          unreadCount,
        };
      })
    );

    // Conversations with an actual message sort most-recent-first; anyone
    // reachable but never yet messaged trails behind, alphabetically.
    conversations.sort((a, b) => {
      if (!a.lastMessageAt && !b.lastMessageAt) return a.name.localeCompare(b.name);
      if (!a.lastMessageAt) return 1;
      if (!b.lastMessageAt) return -1;
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    });

    res.json({ success: true, conversations });
  } catch (err) {
    console.error("GET /api/messages/conversations failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// ?after=<messageId> is a polling cursor — returns only what's arrived
// since the last message the client already has, oldest-first so it appends
// straight onto the bottom of an already-rendered list. Without it, this is
// an initial load: the most recent PAGE_SIZE messages, oldest-first for
// top-to-bottom rendering. Loading further back history than that isn't
// supported yet — not needed until real usage shows a conversation actually
// runs that long.
export async function getMessages(req, res) {
  try {
    // A malformed/missing :otherUserId (seen in practice as the literal
    // string "undefined" — a client bug, not a real id) would otherwise
    // reach Enrollment.findOne and blow up as an unhandled Mongoose
    // CastError instead of a clean 400.
    if (!mongoose.isValidObjectId(req.params.otherUserId)) {
      res.status(400).json({ success: false, message: "Invalid user id." });
      return;
    }

    await connectDB();

    const pair = await resolveCounterpart(req, req.params.otherUserId);
    if (!pair) {
      res.status(403).json({ success: false, message: "You can't message this person." });
      return;
    }

    const conversation = await Conversation.findOne(pair).lean();
    if (!conversation) {
      res.json({ success: true, messages: [] });
      return;
    }

    const { after } = req.query;
    let messages;
    if (after) {
      const afterMessage = await Message.findById(after).select("createdAt").lean();
      const filter = { conversation: conversation._id };
      if (afterMessage) filter.createdAt = { $gt: afterMessage.createdAt };
      messages = await Message.find(filter).sort({ createdAt: 1 }).limit(PAGE_SIZE).lean();
    } else {
      const recent = await Message.find({ conversation: conversation._id })
        .sort({ createdAt: -1 })
        .limit(PAGE_SIZE)
        .lean();
      messages = recent.reverse();
    }

    // Best-effort read receipt — this user has now fetched everything the
    // other party sent, regardless of whether this call was an initial load
    // or a poll.
    await Message.updateMany(
      { conversation: conversation._id, sender: { $ne: req.user.id }, readAt: null },
      { $set: { readAt: new Date() } }
    );

    res.json({ success: true, messages });
  } catch (err) {
    console.error("GET /api/messages/conversations/:otherUserId failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function sendMessage(req, res) {
  try {
    const { text } = req.body;
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ success: false, message: "Message text is required." });
      return;
    }
    const trimmedText = text.trim();
    if (trimmedText.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ success: false, message: "Message is too long." });
      return;
    }
    if (!mongoose.isValidObjectId(req.params.otherUserId)) {
      res.status(400).json({ success: false, message: "Invalid user id." });
      return;
    }

    await connectDB();

    const pair = await resolveCounterpart(req, req.params.otherUserId);
    if (!pair) {
      res.status(403).json({ success: false, message: "You can't message this person." });
      return;
    }

    // Lazily created on first message — the pair is already chat-reachable
    // via listConversations from Enrollment alone, so there's no separate
    // "create a conversation" step for the client to call first.
    const conversation = await Conversation.findOneAndUpdate(
      pair,
      { $setOnInsert: pair },
      { upsert: true, returnDocument: "after" }
    );

    const message = await Message.create({ conversation: conversation._id, sender: req.user.id, text: trimmedText });

    conversation.lastMessageAt = message.createdAt;
    conversation.lastMessageText = trimmedText;
    await conversation.save();

    const recipientId = req.user.role === "teacher" ? pair.student : pair.tutor;
    const [sender, recipient] = await Promise.all([
      User.findById(req.user.id).select("name").lean(),
      User.findById(recipientId).select("pushToken notificationsEnabled").lean(),
    ]);
    if (recipient?.pushToken && recipient.notificationsEnabled !== false) {
      await sendPushNotifications([recipient.pushToken], {
        title: sender?.name || "New message",
        body: trimmedText,
        data: { type: "new-message", otherUserId: req.user.id },
      });
    }

    res.json({ success: true, message });
  } catch (err) {
    console.error("POST /api/messages/conversations/:otherUserId failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
