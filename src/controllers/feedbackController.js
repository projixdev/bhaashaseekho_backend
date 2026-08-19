import { connectDB } from "../config/db.js";
import Class from "../models/Class.js";
import Feedback from "../models/Feedback.js";

const VALID_SENTIMENTS = ["agree", "disagree"];

// GET /api/classes deliberately excludes completed classes for students
// (see classController.js) — there's otherwise no way for the app to learn
// a class it needs feedback for exists at all. $elemMatch is required here,
// not two separate attendance.* conditions, so student+status are checked
// against the same attendance entry rather than any entry matching either.
export async function listPendingFeedback(req, res) {
  try {
    await connectDB();

    const completedClasses = await Class.find({
      status: "completed",
      attendance: { $elemMatch: { student: req.user.id, status: "present" } },
    })
      .select("subject scheduledAt")
      .lean();

    if (completedClasses.length === 0) {
      res.json({ success: true, classes: [] });
      return;
    }

    const alreadyGiven = await Feedback.find({
      student: req.user.id,
      class: { $in: completedClasses.map((c) => c._id) },
    })
      .select("class")
      .lean();
    const givenIds = new Set(alreadyGiven.map((f) => f.class.toString()));

    const pending = completedClasses.filter((c) => !givenIds.has(c._id.toString()));

    res.json({ success: true, classes: pending });
  } catch (err) {
    console.error("GET /api/feedback/pending failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function createFeedback(req, res) {
  try {
    await connectDB();

    const { classId, sentiment, comment } = req.body;
    if (!classId || !VALID_SENTIMENTS.includes(sentiment)) {
      res.status(400).json({ success: false, message: "classId and a valid sentiment are required." });
      return;
    }

    const classDoc = await Class.findById(classId);
    if (!classDoc) {
      res.status(404).json({ success: false, message: "Class not found." });
      return;
    }

    // A class that hasn't been ended yet has an empty attendance array
    // (classController.endClass is the only writer), so this naturally
    // rejects feedback on a not-yet-completed class too, not just on
    // partial/absent attendance.
    const attendanceEntry = classDoc.attendance.find((entry) => entry.student.toString() === req.user.id);
    if (!attendanceEntry || attendanceEntry.status !== "present") {
      res.status(403).json({ success: false, message: "You can only leave feedback for a class you attended." });
      return;
    }

    let feedback;
    try {
      feedback = await Feedback.create({
        class: classId,
        student: req.user.id,
        tutor: classDoc.tutor,
        sentiment,
        comment: typeof comment === "string" ? comment.trim() : "",
      });
    } catch (err) {
      // The unique (class, student) index is the real guard — this just
      // turns its duplicate-key error into a clean, readable response
      // instead of a raw Mongo error reaching the client.
      if (err.code === 11000) {
        res.status(409).json({ success: false, message: "You've already left feedback for this class." });
        return;
      }
      throw err;
    }

    res.status(201).json({ success: true, feedback });
  } catch (err) {
    console.error("POST /api/feedback failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function listFeedback(req, res) {
  try {
    await connectDB();

    const feedback = await Feedback.find({})
      .sort({ createdAt: -1 })
      .populate("student", "name")
      .populate("tutor", "name")
      .populate("class", "subject scheduledAt")
      .lean();

    // A student/tutor/class deleted after feedback was left behind orphans
    // the reference — populate() resolves that field to null rather than
    // erroring, and the app can't render a card missing any of the three.
    // Same shape as rosterController's filter for an enrollment whose
    // student no longer exists.
    const clean = feedback.filter((f) => f.student && f.tutor && f.class);

    res.json({ success: true, feedback: clean });
  } catch (err) {
    console.error("GET /api/feedback failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
