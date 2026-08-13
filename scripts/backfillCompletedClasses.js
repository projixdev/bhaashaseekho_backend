// Run once, before the assessment gate switches from the old scheduledAt<now
// stand-in to the real User.completedClassCount field (ROADMAP.md Phase 13).
// Computes each student's count under the OLD logic and writes it into the
// new field, so no student's progress silently resets to 0 the moment the
// switch lands. Prints a per-student before/after so the write is auditable,
// not silent.
//
// Usage:
//   node scripts/backfillCompletedClasses.js
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import Class from "../src/models/Class.js";

async function main() {
  await connectDB();

  const students = await User.find({ role: "student" })
    .select("name phone completedClassCount")
    .sort({ createdAt: 1 })
    .lean();

  console.log(`Backfilling completedClassCount for ${students.length} student(s) (old logic: classes with scheduledAt < now they were enrolled in):\n`);

  let changed = 0;
  for (const student of students) {
    const oldLogicCount = await Class.countDocuments({
      students: student._id,
      scheduledAt: { $lt: new Date() },
    });
    const before = student.completedClassCount ?? 0;

    if (oldLogicCount !== before) {
      await User.updateOne({ _id: student._id }, { $set: { completedClassCount: oldLogicCount } });
      changed += 1;
    }

    console.log(
      `${student.name || "(no name)"} (${student.phone}): ${before} -> ${oldLogicCount}${
        oldLogicCount === before ? " (unchanged)" : ""
      }`
    );
  }

  console.log(`\nDone. ${changed} of ${students.length} student(s) updated.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});
