import { connectDB } from "../config/db.js";
import { uploadBuffer } from "../config/cloudinary.js";
import Assignment from "../models/Assignment.js";
import Enrollment from "../models/Enrollment.js";
import User from "../models/User.js";
import { notifyAssignmentAssigned, notifyAssignmentSubmitted, notifyAssignmentReviewed } from "../services/assignmentNotifications.js";

// Assessments (not homework) unlock once a student has had this many
// classes. Driven by User.completedClassCount, written by
// classController.endClass when a tutor marks a student "present"
// (ROADMAP.md Phase 13) — replaces the old scheduledAt-based stand-in.
// Exported so adminController's student aggregation (ROADMAP.md Phase 17)
// computes the exact same unlock status from a single source of truth,
// rather than risking a second, silently-drifting copy of "10".
export const ASSESSMENT_UNLOCK_AFTER_CLASSES = 10;

export async function listAssignments(req, res) {
  try {
    await connectDB();

    if (req.user.role === "teacher") {
      const assignments = await Assignment.find({ tutor: req.user.id })
        .sort({ createdAt: -1 })
        .populate("student", "name phone")
        .lean();
      res.json({ success: true, assignments });
      return;
    }

    const student = await User.findById(req.user.id).select("completedClassCount").lean();
    const classesCompleted = student?.completedClassCount ?? 0;
    const assessmentsUnlocked = classesCompleted >= ASSESSMENT_UNLOCK_AFTER_CLASSES;

    const homework = await Assignment.find({ student: req.user.id, type: "homework" })
      .sort({ dueDate: 1, createdAt: -1 })
      .populate("tutor", "name")
      .lean();

    const assessments = assessmentsUnlocked
      ? await Assignment.find({ student: req.user.id, type: "assessment" })
          .sort({ dueDate: 1, createdAt: -1 })
          .populate("tutor", "name")
          .lean()
      : [];

    res.json({
      success: true,
      classesCompleted,
      assessmentsUnlockAt: ASSESSMENT_UNLOCK_AFTER_CLASSES,
      assessmentsUnlocked,
      homework,
      assessments,
    });
  } catch (err) {
    console.error("GET /api/assignments failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function submitAssignment(req, res) {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "A submission file is required." });
      return;
    }

    await connectDB();

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment || assignment.student.toString() !== req.user.id) {
      res.status(404).json({ success: false, message: "Assignment not found." });
      return;
    }

    // Uploaded server-side — the app never sees the Cloudinary credentials.
    const uploaded = await uploadBuffer(req.file.buffer, {
      folder: `bhaashaseekho/submissions/${req.user.id}`,
    });

    assignment.submissionUrl = uploaded.secure_url;
    assignment.submittedAt = new Date();
    assignment.status = "submitted";
    await assignment.save();

    await notifyAssignmentSubmitted(assignment);

    res.json({ success: true, assignment });
  } catch (err) {
    console.error("POST /api/assignments/:id/submit failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function createAssignment(req, res) {
  try {
    const { studentId, type, title, instructions, dueDate } = req.body;

    if (!studentId || !["homework", "assessment"].includes(type) || !title) {
      res.status(400).json({ success: false, message: "studentId, type, and title are required." });
      return;
    }

    await connectDB();

    // Only students on this teacher's own roster — prevents assigning work
    // to someone else's student.
    const enrollment = await Enrollment.findOne({ tutor: req.user.id, student: studentId });
    if (!enrollment) {
      res.status(403).json({ success: false, message: "This student isn't assigned to you." });
      return;
    }

    let attachmentUrl = "";
    if (req.file) {
      const uploaded = await uploadBuffer(req.file.buffer, {
        folder: `bhaashaseekho/assignments/${req.user.id}`,
      });
      attachmentUrl = uploaded.secure_url;
    }

    let parsedDueDate = null;
    if (dueDate) {
      parsedDueDate = new Date(dueDate);
      if (Number.isNaN(parsedDueDate.getTime())) {
        res.status(400).json({ success: false, message: "Invalid due date." });
        return;
      }
    }

    const assignment = await Assignment.create({
      type,
      title,
      instructions: instructions || "",
      student: studentId,
      tutor: req.user.id,
      attachmentUrl,
      dueDate: parsedDueDate,
    });

    await notifyAssignmentAssigned(assignment);

    res.json({ success: true, assignment });
  } catch (err) {
    console.error("POST /api/assignments failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function reviewAssignment(req, res) {
  try {
    await connectDB();

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment || assignment.tutor.toString() !== req.user.id) {
      res.status(404).json({ success: false, message: "Assignment not found." });
      return;
    }

    // "Reviewed" implies graded, not just looked at — parents/students would
    // otherwise see a reviewed assignment with no score and assume it's a
    // bug. Require one up front rather than allowing an ambiguous state.
    const score = typeof req.body.score === "string" ? req.body.score.trim() : "";
    if (!score) {
      res.status(400).json({ success: false, message: "A score is required to mark this assignment reviewed." });
      return;
    }

    assignment.score = score;
    assignment.status = "reviewed";
    await assignment.save();

    await notifyAssignmentReviewed(assignment);

    res.json({ success: true, assignment });
  } catch (err) {
    console.error("PATCH /api/assignments/:id/review failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
