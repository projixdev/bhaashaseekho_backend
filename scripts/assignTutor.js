// Admin-only tool — reassigns which tutor a student's enrollment points to,
// without needing to retype their name (unlike re-running createUser.js).
// Run locally with your own .env; never exposed over HTTP.
//
// This is the "founder teaches the first few classes, then hands off to a
// permanent tutor" workflow: schedule those first classes with the founder
// as --tutor in scripts/scheduleClass.js, then run this once to point the
// student's enrollment at their real tutor going forward. Nothing needs to
// change about past classes — GET /api/classes shows a student every class
// they're in regardless of which tutor taught it, so their history and
// future classes just show up together, in order.
//
// Usage:
//   node scripts/assignTutor.js --student 9123456789 --tutor 9876543210
//   node scripts/assignTutor.js --student 9123456789 --course hindi --tutor 9876543210
//
// --course is only required if the student has more than one enrollment.
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import Enrollment from "../src/models/Enrollment.js";
import { normalizePhone } from "../src/utils/validation.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.student || !args.tutor) {
    console.error(
      "Usage: node scripts/assignTutor.js --student <phone> [--course <slug>] --tutor <phone>"
    );
    process.exitCode = 1;
    return;
  }

  await connectDB();

  const student = await User.findOne({ phone: normalizePhone(args.student), role: "student" });
  if (!student) {
    console.error(`No student found with phone ${args.student}.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const tutor = await User.findOne({ phone: normalizePhone(args.tutor), role: "teacher" });
  if (!tutor) {
    console.error(`No teacher found with phone ${args.tutor}.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const enrollments = await Enrollment.find({ student: student._id });
  if (enrollments.length === 0) {
    console.error(`${student.name} has no enrollment yet — create one first with scripts/createUser.js --course.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  let enrollment;
  if (args.course) {
    enrollment = enrollments.find((e) => e.courseSlug === String(args.course).toLowerCase());
    if (!enrollment) {
      console.error(`${student.name} isn't enrolled in "${args.course}".`);
      process.exitCode = 1;
      await mongoose.disconnect();
      return;
    }
  } else if (enrollments.length === 1) {
    enrollment = enrollments[0];
  } else {
    console.error(
      `${student.name} has multiple enrollments — specify --course. Options: ${enrollments.map((e) => e.courseSlug).join(", ")}`
    );
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const previousTutor = enrollment.tutor;
  enrollment.tutor = tutor._id;
  await enrollment.save();

  console.log(
    `${student.name}'s "${enrollment.courseSlug}" enrollment now points to ${tutor.name}${previousTutor ? " (was previously assigned)" : " (was unassigned)"}. Schedule their next classes with --tutor ${args.tutor}.`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});
