// Admin-only tool — schedules a Class session directly in MongoDB. Run
// locally with your own .env; never exposed over HTTP.
//
// This is no longer the primary way to schedule a class — a teacher can now
// do it themselves from the app (POST /api/classes,
// classController.createClass). This script is kept as a fallback/emergency
// tool (e.g. bulk-scheduling, or scheduling on a teacher's behalf) and still
// works exactly as before, including multi-student/group batches, which the
// app's simpler single-student picker doesn't expose yet.
//
// Usage:
//   node scripts/scheduleClass.js --tutor 9876543210 --students 9123456789 --subject "Hindi Conversation" --at "2026-08-15T18:00" --duration 60 --link https://meet.google.com/xyz
//   node scripts/scheduleClass.js --tutor 9876543210 --students 9123456789,9223344556 --subject "Hindi Conversation" --at "2026-08-15T18:00" --batch group
//
// --link is optional — omit it and a Google Meet link is generated
// automatically via the Calendar API, same as the app's own scheduling flow
// (classController.createClass, Phase 19). Pass --link to use an existing
// link instead (e.g. Zoom, or a link created outside this system) — doing
// so skips the Calendar API call entirely, so there's no Calendar event
// backing it for a later reschedule/cancel to patch or delete.
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import Class from "../src/models/Class.js";
import { normalizePhone } from "../src/utils/validation.js";
import { createMeetEvent } from "../src/services/googleCalendarService.js";

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

  if (!args.tutor || !args.students || !args.subject || !args.at) {
    console.error(
      'Usage: node scripts/scheduleClass.js --tutor <phone> --students <phone,phone,...> --subject "Hindi Conversation" --at "2026-08-15T18:00" [--duration 45] [--link https://...] [--batch 1-on-1|group]'
    );
    process.exitCode = 1;
    return;
  }

  const scheduledAt = new Date(args.at);
  if (Number.isNaN(scheduledAt.getTime())) {
    console.error(`Invalid --at date: ${args.at}`);
    process.exitCode = 1;
    return;
  }

  await connectDB();

  const tutorPhone = normalizePhone(args.tutor);
  const tutor = await User.findOne({ phone: tutorPhone, role: "teacher" });
  if (!tutor) {
    console.error(`No teacher found with phone ${args.tutor}. Create them first with scripts/createUser.js.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const studentPhones = String(args.students)
    .split(",")
    .map((p) => normalizePhone(p.trim()))
    .filter(Boolean);

  const students = await User.find({ phone: { $in: studentPhones }, role: "student" });
  if (students.length !== studentPhones.length) {
    const found = new Set(students.map((s) => s.phone));
    const missing = studentPhones.filter((p) => !found.has(p));
    console.error(`No student found for phone(s): ${missing.join(", ")}. Create them first.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const batchType = args.batch === "group" || students.length > 1 ? "group" : "1-on-1";
  const durationMinutes = args.duration ? Number(args.duration) : 45;

  let meetingLink = args.link || "";
  let googleCalendarEventId = null;
  if (!args.link) {
    // Real emails so Meet recognizes them as already-invited and skips the
    // "ask to join" knock — see googleCalendarService.js's own comment on
    // createMeetEvent for why this matters (the event's organizer is a
    // Workspace identity nobody actually monitors).
    const attendeeEmails = [tutor.email, ...students.map((s) => s.email)].filter(Boolean);
    try {
      const meetEvent = await createMeetEvent({ subject: args.subject, scheduledAt, durationMinutes, attendeeEmails });
      meetingLink = meetEvent.meetingLink;
      googleCalendarEventId = meetEvent.eventId;
    } catch (err) {
      console.error("Could not create a Google Meet link:", err);
      console.error("Pass --link to supply one manually instead. Nothing was scheduled.");
      process.exitCode = 1;
      await mongoose.disconnect();
      return;
    }
  }

  const cls = await Class.create({
    subject: args.subject,
    tutor: tutor._id,
    students: students.map((s) => s._id),
    batchType,
    scheduledAt,
    durationMinutes,
    meetingLink,
    googleCalendarEventId,
  });

  console.log(
    `Scheduled "${cls.subject}" (${batchType}) with ${tutor.name} for ${students.map((s) => s.name).join(", ")} at ${scheduledAt.toISOString()} — id ${cls._id}${meetingLink ? `, link: ${meetingLink}` : ""}`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});
