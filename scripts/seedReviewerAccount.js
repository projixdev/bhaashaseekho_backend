// One-time seed for the Google Play Store reviewer test-login account (see
// authController.js's REVIEWER BYPASS comments). Run locally with your own
// .env (REVIEWER_TEST_PHONE must already be set there) whenever the
// reviewer account needs creating, or re-pointing at a different course/tutor.
// Reads the phone from REVIEWER_TEST_PHONE rather than a --phone flag --
// it must exactly match the bypass check's env var, and a separately-typed
// flag could silently drift from it.
//
// Usage:
//   node scripts/seedReviewerAccount.js --course kannada-speaking --tutor 9876543210
//   node scripts/seedReviewerAccount.js --course kannada-speaking
//
// --course is required -- match the real taxonomy slug format the admin
// dashboard uses (see createUser.js's own comment on this). --tutor is
// optional and must be an existing teacher's phone; without it the
// enrollment is still created with no tutor assigned (the app already
// renders that as "Tutor not assigned yet", not an empty state).
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import User from "../src/models/User.js";
import Enrollment from "../src/models/Enrollment.js";

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

  if (!env.reviewerTestPhone) {
    console.error("REVIEWER_TEST_PHONE isn't set in .env -- set it first, this script reads the phone from there.");
    process.exitCode = 1;
    return;
  }
  if (!args.course) {
    console.error("Usage: node scripts/seedReviewerAccount.js --course <slug> [--tutor <phone>] [--email <address>]");
    process.exitCode = 1;
    return;
  }

  const phone = env.reviewerTestPhone;
  const email = args.email ? String(args.email).trim().toLowerCase() : "reviewer@bhaashaseekho.com";

  await connectDB();

  let user = await User.findOne({ phone });
  const isNew = !user;
  if (!user) user = new User({ phone });

  user.name = "Play Store Reviewer";
  user.role = "student";
  user.email = email;
  user.isTrial = false;
  user.accessExpiresAt = null;
  await user.save();

  console.log(
    `${isNew ? "Created" : "Updated"} reviewer account: ${user.name} (${user.phone}) <${user.email}> — id ${user._id}`
  );

  let tutorId = null;
  if (args.tutor) {
    const tutor = await User.findOne({ phone: String(args.tutor).replace(/[^\d]/g, ""), role: "teacher" });
    if (!tutor) {
      console.error(`No teacher found with phone ${args.tutor} -- create them first. Enrollment not saved.`);
      process.exitCode = 1;
      await mongoose.disconnect();
      return;
    }
    tutorId = tutor._id;
  }

  const courseSlug = String(args.course).toLowerCase();
  const enrollment = await Enrollment.findOneAndUpdate(
    { student: user._id, courseSlug },
    { student: user._id, courseSlug, tutor: tutorId, batchType: "1-on-1", status: "active" },
    { upsert: true, returnDocument: "after" }
  );

  console.log(
    `Enrolled reviewer in "${courseSlug}" (${enrollment.batchType})${tutorId ? ` with tutor ${args.tutor}` : " -- no tutor assigned yet"}`
  );
  console.log(
    "Done. The reviewer can sign in with REVIEWER_TEST_PHONE + REVIEWER_TEST_OTP once both are set wherever this app is actually deployed."
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});
