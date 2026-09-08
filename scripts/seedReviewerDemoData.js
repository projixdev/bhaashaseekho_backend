// Seeds realistic demo content for the app-store review accounts so no
// screen reads as empty during review — companion to seedReviewerAccount.js,
// which creates the student account itself. Safe to re-run before a future
// submission to refresh the dates (pass --force to replace what a previous
// run created).
//
// Scope is deliberately narrow and hard-coded to the two review accounts
// below: it only ever writes Class, Assignment and Feedback documents tied
// to that exact student/tutor pair, plus that student's own
// completedClassCount. It never touches Enrollment (the rate/balance record
// is set up by an admin and is not this script's to change), and therefore
// also never writes TeacherEarning — the real End Class flow credits the
// ledger and decrements Enrollment.classesRemaining together
// (classController.creditCompletedClass), so doing one without the other
// here would leave the two disagreeing. The teacher's Earnings screen
// consequently stays at zero; that's a deliberate trade, not an oversight.
//
// Usage:
//   node scripts/seedReviewerDemoData.js
//   node scripts/seedReviewerDemoData.js --force
import zlib from "node:zlib";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { uploadBuffer } from "../src/config/cloudinary.js";
import User from "../src/models/User.js";
import Enrollment from "../src/models/Enrollment.js";
import Class from "../src/models/Class.js";
import Assignment from "../src/models/Assignment.js";
import Feedback from "../src/models/Feedback.js";

const STUDENT_PHONE = "8147777707";
const TEACHER_PHONE = "9876512340";

// Class times are picked as 19:30-20:30 IST (14:00-15:00 UTC), which is both
// a plausible evening slot for an India-based tutoring service and 07:00-08:00
// for a US Pacific reviewer — so the teacher's week grid (which renders
// 7 AM-10 PM in the *device's* local time) shows them properly either way
// rather than clamping them to the top edge.
function atUtc(dayOffset, hourUtc, minuteUtc) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourUtc, minuteUtc, 0, 0);
  return d;
}

// A PNG, not a PDF, on purpose. This Cloudinary account has the default
// "PDF and ZIP delivery" restriction switched on, so an uploaded PDF stores
// fine but every delivery URL answers 401 (x-cld-error: deny or ACL
// failure) — a reviewer tapping "View your submission" would get a blank
// screen. An image also matches the app's own primary submission flow
// ("photograph and submit your handwritten homework", expo-image-picker).
// If PDF delivery is ever enabled on the account, this can go back to a PDF.
//
// Drawn procedurally rather than shipped as a checked-in binary: a ruled
// notebook page with a red margin and ink-like strokes, so at a glance it
// reads as a real photo of handwritten homework instead of a blank box.
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function buildHomeworkPhoto(seed) {
  const W = 760;
  const H = 1000;
  const px = Buffer.alloc(W * H * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };

  // Paper
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const shade = 246 + ((x * 7 + y * 3) % 5);
      set(x, y, shade, shade - 2, shade - 8);
    }
  }

  // Ruled lines + red margin
  const firstLine = 120;
  const lineGap = 52;
  for (let y = firstLine; y < H - 60; y += lineGap) {
    for (let x = 40; x < W - 40; x++) set(x, y, 198, 212, 232);
  }
  for (let y = 40; y < H - 40; y++) {
    set(96, y, 226, 152, 152);
    set(97, y, 226, 152, 152);
  }

  // Deterministic pseudo-random so re-runs produce the same page.
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };

  // Ink: wavy word-like strokes sitting on the ruled lines.
  for (let y = firstLine; y < H - 120; y += lineGap) {
    let x = 120 + rnd() * 30;
    const lineEnd = W - 80 - rnd() * 220;
    while (x < lineEnd) {
      const wordLen = 40 + rnd() * 90;
      const amp = 5 + rnd() * 5;
      const freq = 0.18 + rnd() * 0.12;
      const phase = rnd() * 6.283;
      for (let t = 0; t < wordLen; t++) {
        const yy = y - 6 + Math.sin(t * freq + phase) * amp;
        for (let th = 0; th < 2; th++) {
          set(Math.round(x + t), Math.round(yy) + th, 38, 52, 108);
        }
      }
      x += wordLen + 14 + rnd() * 20;
    }
  }

  const rawWithFilters = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    rawWithFilters[y * (1 + W * 3)] = 0; // filter: none
    px.copy(rawWithFilters, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(rawWithFilters, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const force = process.argv.includes("--force");
  await connectDB();

  const student = await User.findOne({ phone: STUDENT_PHONE, role: "student" });
  const teacher = await User.findOne({ phone: TEACHER_PHONE, role: "teacher" });
  if (!student || !teacher) {
    console.error(
      `Missing account(s): student ${STUDENT_PHONE} ${student ? "ok" : "NOT FOUND"}, teacher ${TEACHER_PHONE} ${
        teacher ? "ok" : "NOT FOUND"
      }. Create them first.`
    );
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  // Read-only: the class's courseSlug has to match the real enrollment, or
  // endClass can't resolve which enrollment a class belongs to later.
  const enrollment = await Enrollment.findOne({ student: student._id, tutor: teacher._id, status: "active" }).lean();
  if (!enrollment) {
    console.error("No active enrollment linking these two accounts — expected one, and this script won't create it.");
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  const { courseSlug } = enrollment;

  const existingClasses = await Class.countDocuments({ students: student._id, tutor: teacher._id });
  const existingAssignments = await Assignment.countDocuments({ student: student._id, tutor: teacher._id });
  if ((existingClasses > 0 || existingAssignments > 0) && !force) {
    console.error(
      `Already seeded (${existingClasses} classes, ${existingAssignments} assignments). Re-run with --force to delete those and reseed.`
    );
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (force && (existingClasses > 0 || existingAssignments > 0)) {
    const oldClasses = await Class.find({ students: student._id, tutor: teacher._id }).select("_id").lean();
    const oldIds = oldClasses.map((c) => c._id);
    const removedFeedback = await Feedback.deleteMany({ student: student._id, class: { $in: oldIds } });
    const removedClasses = await Class.deleteMany({ _id: { $in: oldIds } });
    const removedAssignments = await Assignment.deleteMany({ student: student._id, tutor: teacher._id });
    console.log(
      `--force: removed ${removedClasses.deletedCount} classes, ${removedAssignments.deletedCount} assignments, ${removedFeedback.deletedCount} feedback entries.\n`
    );
  }

  const created = { classes: [], assignments: [], feedback: [] };

  // ---- Classes: 2 completed in the past, 2 upcoming ----------------------
  const classPlan = [
    { subject: "Kannada Speaking — Everyday Greetings", when: atUtc(-6, 14, 0), duration: 45, done: true },
    { subject: "Kannada Speaking — Numbers and Shopping", when: atUtc(-3, 14, 30), duration: 60, done: true },
    { subject: "Kannada Speaking — Asking for Directions", when: atUtc(2, 14, 0), duration: 45, done: false },
    { subject: "Kannada Speaking — Ordering at a Restaurant", when: atUtc(5, 14, 30), duration: 60, done: false },
  ];

  for (const [i, plan] of classPlan.entries()) {
    const doc = new Class({
      subject: plan.subject,
      tutor: teacher._id,
      students: [student._id],
      batchType: "1-on-1",
      courseSlug,
      scheduledAt: plan.when,
      durationMinutes: plan.duration,
      meetingLink: `https://meet.google.com/bsk-demo-${String(i + 1).padStart(2, "0")}`,
      // Left null on purpose: no real Google Calendar event backs these, and
      // cancel/postpone already handle that case (see classController's
      // googleCalendarEventId checks) rather than calling the Calendar API.
      googleCalendarEventId: null,
      // Mirrors exactly what classController.endClass writes when a tutor
      // ends a class with the student marked present.
      status: plan.done ? "completed" : "upcoming",
      attendance: plan.done ? [{ student: student._id, status: "present" }] : [],
      attendanceMarkedBy: plan.done ? "teacher" : null,
    });
    await doc.save();
    created.classes.push(doc);
  }

  const completedClasses = created.classes.filter((c) => c.status === "completed");

  // Truthful recount rather than a blind +=, so this stays correct if the
  // script is re-run: it's exactly how many completed classes this student
  // was actually marked present for.
  const attendedCount = await Class.countDocuments({
    status: "completed",
    attendance: { $elemMatch: { student: student._id, status: "present" } },
  });
  student.completedClassCount = attendedCount;
  await student.save();

  // ---- Assignments: one still to do, one awaiting review, one reviewed ---
  console.log("Uploading sample submission images to Cloudinary...");
  const [submittedUpload, reviewedUpload] = await Promise.all([
    uploadBuffer(buildHomeworkPhoto(20260908), { folder: `bhaashaseekho/submissions/${student._id}` }),
    uploadBuffer(buildHomeworkPhoto(777701), { folder: `bhaashaseekho/submissions/${student._id}` }),
  ]);

  const assignmentPlan = [
    {
      type: "homework",
      title: "Practice greetings out loud",
      instructions: "Record yourself saying each greeting from today's class three times, then upload a photo of your written notes.",
      dueDate: atUtc(3, 12, 0),
      status: "assigned",
    },
    {
      type: "homework",
      title: "Numbers 1 to 20 in Kannada",
      instructions: "Write out numbers 1-20 in Kannada script and upload your worksheet.",
      dueDate: atUtc(-1, 12, 0),
      status: "submitted",
      submissionUrl: submittedUpload.secure_url,
      submittedAt: atUtc(-2, 9, 0),
    },
    {
      type: "homework",
      title: "Everyday greetings worksheet",
      instructions: "Complete the greetings worksheet and upload it before the next class.",
      dueDate: atUtc(-4, 12, 0),
      status: "reviewed",
      submissionUrl: reviewedUpload.secure_url,
      submittedAt: atUtc(-5, 10, 30),
      score: "9/10",
    },
  ];

  for (const plan of assignmentPlan) {
    const doc = new Assignment({
      type: plan.type,
      title: plan.title,
      instructions: plan.instructions,
      student: student._id,
      tutor: teacher._id,
      dueDate: plan.dueDate,
      status: plan.status,
      submissionUrl: plan.submissionUrl ?? "",
      submittedAt: plan.submittedAt ?? null,
      score: plan.score ?? "",
    });
    await doc.save();
    created.assignments.push(doc);
  }

  // ---- Feedback: only for the older completed class ----------------------
  // The newer one is left without feedback on purpose so the student's Home
  // screen still shows its "How was your class?" prompt card during review —
  // an empty feedback prompt would hide that feature entirely.
  const feedbackDoc = await Feedback.create({
    class: completedClasses[0]._id,
    student: student._id,
    tutor: teacher._id,
    sentiment: "agree",
    comment: "Very clear explanations and lots of speaking practice. Felt comfortable trying out full sentences.",
  });
  created.feedback.push(feedbackDoc);

  // ---- Summary -----------------------------------------------------------
  console.log("\n================ SEEDED ================");
  console.log(`Student : ${student.name} (${student.phone})  id ${student._id}`);
  console.log(`Teacher : ${teacher.name} (${teacher.phone})  id ${teacher._id}`);
  console.log(`Course  : ${courseSlug}  (enrollment ${enrollment._id} — untouched)`);

  console.log(`\nCLASSES (${created.classes.length})`);
  for (const c of created.classes) {
    console.log(
      `  ${c._id}  ${c.status.padEnd(9)} ${c.scheduledAt.toISOString()}  ${c.durationMinutes}min  ${c.subject}`
    );
  }

  console.log(`\nASSIGNMENTS (${created.assignments.length})`);
  for (const a of created.assignments) {
    console.log(
      `  ${a._id}  ${a.status.padEnd(9)} ${a.score ? `score ${a.score}  ` : ""}${a.title}${
        a.submissionUrl ? `\n      file: ${a.submissionUrl}` : ""
      }`
    );
  }

  console.log(`\nFEEDBACK (${created.feedback.length})`);
  for (const f of created.feedback) {
    console.log(`  ${f._id}  ${f.sentiment}  on class ${f.class}`);
  }

  console.log(`\nStudent completedClassCount -> ${student.completedClassCount} (assessments unlock at 10)`);
  console.log("Enrollment, TeacherEarning: not written (see header comment).");
  console.log("========================================\n");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});
