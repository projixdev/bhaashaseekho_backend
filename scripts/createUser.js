// Admin-only tool — creates or updates a User (and, for students, their
// course Enrollment) directly in MongoDB. Run locally with your own .env;
// never exposed over HTTP. This is how student accounts get activated after
// enrolling (the website is marketing-only and never creates accounts
// itself) and how teacher accounts get created, since neither role can
// self-register through the app's OTP login.
//
// --role teacher is no longer the primary way to create a teacher — the
// admin dashboard's "Add Teacher" form (POST /api/admin/teachers,
// adminController.createTeacher) is, as of ROADMAP.md's admin-dashboard
// rebuild. This script is kept as a fallback/emergency tool (e.g. the
// dashboard is down, or you're scripting a bulk import) and still works
// exactly as before — student creation/enrollment is untouched either way.
//
// Usage:
//   node scripts/createUser.js --phone 9876543210 --name "Priya Nair" --role teacher --email priya@example.com
//   node scripts/createUser.js --phone 9123456789 --name "Rohan K" --role student --email rohan@example.com --course hindi-academics --tutor 9876543210 --batch group
//
// --course takes any string as-is (no fixed list enforced here) — the admin
// dashboard's Add Student form is what actually enforces the real taxonomy
// (Phase 21: 3 languages x 4 sub-courses, e.g. "hindi-academics",
// "kannada-speaking" — see bhaashaseekho_website/data/enrollmentCourses.js).
// Match that format when using this script so a CLI-created enrollment
// doesn't end up on a slug the dashboard doesn't recognize.
// --email is optional but should always be passed going forward: OTP
// delivery is email-only (ROADMAP.md Phase 16) — an account created without
// one can't receive a login code until an admin re-runs this script with
// --email to backfill it.
// --course/--tutor/--batch only apply to students and are optional — you can
// create a login-capable student account first and assign their enrollment
// later by re-running with those flags (matches by phone, so safe to re-run).
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import Enrollment from "../src/models/Enrollment.js";
import { normalizePhone, PHONE_DIGITS_RE } from "../src/utils/validation.js";
import { sendTeacherWelcomeEmail } from "../src/controllers/adminController.js";

// Mirrors the (unexported) pattern in src/utils/validation.js — duplicated
// rather than exported from there to keep this phase's changes scoped to
// this file.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  if (!args.phone || !args.name) {
    console.error(
      'Usage: node scripts/createUser.js --phone <digits> --name "Full Name" [--role student|teacher] [--email <address>]'
    );
    process.exitCode = 1;
    return;
  }

  const phone = normalizePhone(args.phone);
  if (!PHONE_DIGITS_RE.test(phone)) {
    console.error(`Invalid phone number: ${args.phone}`);
    process.exitCode = 1;
    return;
  }

  let email;
  if (args.email) {
    email = String(args.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      console.error(`Invalid email address: ${args.email}`);
      process.exitCode = 1;
      return;
    }
  }

  const role = args.role === "teacher" ? "teacher" : "student";

  await connectDB();

  let user = await User.findOne({ phone });
  const isNew = !user;
  if (!user) user = new User({ phone });

  user.name = args.name;
  user.role = role;
  if (email) user.email = email;
  await user.save();

  console.log(
    `${isNew ? "Created" : "Updated"} ${user.role}: ${user.name} (${user.phone})${user.email ? ` <${user.email}>` : " — no email on file, cannot receive OTPs yet"} — id ${user._id}`
  );

  // Same welcome email a dashboard-created teacher gets (adminController's
  // createTeacher) — "any teacher profile" should trigger it, not just the
  // web form. Only on genuine creation, not a re-run that just updates an
  // existing teacher's name/email.
  if (isNew && role === "teacher" && user.email) {
    await sendTeacherWelcomeEmail(user);
    console.log(`Welcome email sent to ${user.email}.`);
  }

  if (role === "student" && args.course) {
    let tutorId = null;
    if (args.tutor) {
      const tutorPhone = normalizePhone(args.tutor);
      const tutor = await User.findOne({ phone: tutorPhone, role: "teacher" });
      if (!tutor) {
        console.error(`No teacher found with phone ${args.tutor} — create them first. Enrollment not saved.`);
        process.exitCode = 1;
        await mongoose.disconnect();
        return;
      }
      tutorId = tutor._id;
    }

    const courseSlug = String(args.course).toLowerCase();
    const batchType = args.batch === "group" ? "group" : "1-on-1";

    const enrollment = await Enrollment.findOneAndUpdate(
      { student: user._id, courseSlug },
      { student: user._id, courseSlug, tutor: tutorId, batchType, status: "active" },
      { upsert: true, returnDocument: "after" }
    );

    console.log(
      `Enrolled ${user.name} in "${courseSlug}" (${enrollment.batchType})${tutorId ? ` with tutor ${args.tutor}` : ""}`
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});
