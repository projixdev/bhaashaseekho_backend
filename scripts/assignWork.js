// Admin-only tool — creates a homework or assessment item for a student
// directly in MongoDB. Run locally with your own .env; never exposed over
// HTTP. This is how founder/tutor assign work until Teacher UI (ROADMAP.md
// Phase 6) can do it from the app itself.
//
// Usage:
//   node scripts/assignWork.js --type homework --student 9876500002 --tutor 9876500001 --title "Practice greetings" --instructions "Write 10 sentences using today's greetings and read them aloud" --due "2026-08-20"
//   node scripts/assignWork.js --type assessment --student 9876500002 --tutor 9876500001 --title "Unit 1 Assessment" --attachment "https://res.cloudinary.com/.../unit1.pdf" --due "2026-08-25"
//
// --attachment is a Cloudinary URL — until Teacher UI exists, upload the
// tutor's file via Cloudinary's own dashboard and paste the resulting URL.
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import Assignment from "../src/models/Assignment.js";
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

  if (!args.type || !["homework", "assessment"].includes(args.type) || !args.student || !args.tutor || !args.title) {
    console.error(
      'Usage: node scripts/assignWork.js --type homework|assessment --student <phone> --tutor <phone> --title "..." [--instructions "..."] [--attachment <url>] [--due "2026-08-20"]'
    );
    process.exitCode = 1;
    return;
  }

  await connectDB();

  const studentPhone = normalizePhone(args.student);
  const tutorPhone = normalizePhone(args.tutor);

  const student = await User.findOne({ phone: studentPhone, role: "student" });
  if (!student) {
    console.error(`No student found with phone ${args.student}.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const tutor = await User.findOne({ phone: tutorPhone, role: "teacher" });
  if (!tutor) {
    console.error(`No teacher found with phone ${args.tutor}.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  let dueDate = null;
  if (args.due) {
    dueDate = new Date(args.due);
    if (Number.isNaN(dueDate.getTime())) {
      console.error(`Invalid --due date: ${args.due}`);
      process.exitCode = 1;
      await mongoose.disconnect();
      return;
    }
  }

  const assignment = await Assignment.create({
    type: args.type,
    title: args.title,
    instructions: args.instructions || "",
    student: student._id,
    tutor: tutor._id,
    attachmentUrl: args.attachment || "",
    dueDate,
  });

  console.log(
    `Assigned "${assignment.title}" (${assignment.type}) to ${student.name} from ${tutor.name}${dueDate ? ` — due ${dueDate.toDateString()}` : ""} — id ${assignment._id}`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});
