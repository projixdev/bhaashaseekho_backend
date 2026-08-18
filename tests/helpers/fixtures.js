// Shared seed helpers, reused across test files instead of duplicating
// User/Enrollment/Class/Assignment setup in every test.
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import User from "../../src/models/User.js";
import Enrollment from "../../src/models/Enrollment.js";
import Class from "../../src/models/Class.js";
import Assignment from "../../src/models/Assignment.js";

let seq = 0;
function nextSeq() {
  seq += 1;
  return seq;
}

// 10 digits, matches PHONE_DIGITS_RE — a fixed prefix plus a zero-padded
// counter keeps every phone unique within a test file's in-memory DB.
function nextPhone() {
  return `9${String(700000000 + nextSeq()).padStart(9, "0")}`;
}

// email: null means "no email on file" — leaves the field genuinely absent
// (not stored as null) so the sparse unique index behaves the same way it
// does for a real account created without --email (see User.js's comment).
// A MongoDB sparse index still indexes a field that's present with value
// null, so writing null-instead-of-absent here would risk a false unique
// collision between two "no email" fixtures in the same test.
function buildUserDoc({ n, phone, name, role, email, defaultEmail, completedClassCount, isAdmin, isTrial, accessExpiresAt }) {
  const doc = { phone: phone ?? nextPhone(), name: name ?? `Test ${role} ${n}`, role };
  if (email !== null) doc.email = email ?? defaultEmail;
  if (completedClassCount !== undefined) doc.completedClassCount = completedClassCount;
  if (isAdmin !== undefined) doc.isAdmin = isAdmin;
  if (isTrial !== undefined) doc.isTrial = isTrial;
  if (accessExpiresAt !== undefined) doc.accessExpiresAt = accessExpiresAt;
  return doc;
}

export async function createStudent(overrides = {}) {
  const n = nextSeq();
  return User.create(buildUserDoc({ n, ...overrides, role: "student", defaultEmail: `student${n}@example.com` }));
}

export async function createTeacher(overrides = {}) {
  const n = nextSeq();
  return User.create(buildUserDoc({ n, ...overrides, role: "teacher", defaultEmail: `teacher${n}@example.com` }));
}

export async function createEnrollment({ student, tutor, courseSlug = "kannada", batchType = "1-on-1" }) {
  return Enrollment.create({ student: student._id, tutor: tutor?._id ?? null, courseSlug, batchType });
}

// attendance: [{ studentId, status }] — pass this to seed a class straight
// into the post-endClass state (status "completed" + attendance recorded)
// without going through the real endpoint, for tests whose focus is
// downstream of that (e.g. feedback eligibility), not End Class itself.
export async function createClass({
  tutor,
  students,
  scheduledAt,
  status = "upcoming",
  subject = "Kannada",
  attendance,
  meetingLink,
  googleCalendarEventId,
}) {
  return Class.create({
    subject,
    tutor: tutor._id,
    students: students.map((s) => s._id),
    scheduledAt,
    status: attendance ? "completed" : status,
    attendance: attendance?.map((a) => ({ student: a.studentId, status: a.status })),
    meetingLink,
    googleCalendarEventId,
  });
}

export async function createAssignmentDoc({ student, tutor, type = "homework", title = "Test assignment" }) {
  return Assignment.create({ type, title, student: student._id, tutor: tutor._id });
}

// Signs the same shape/secret as authController.signSession, without
// importing the controller — keeps auth tests independent of the send-otp
// endpoint (and its rate limiter) when a test only needs a valid session.
export function signToken(user, opts = {}) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      phone: user.phone,
      role: user.role,
      isAdmin: Boolean(user.isAdmin),
      isTrial: Boolean(user.isTrial),
      accessExpiresAt: user.accessExpiresAt ? user.accessExpiresAt.toISOString() : null,
    },
    process.env.JWT_SECRET,
    { expiresIn: "30d", ...opts }
  );
}

// Password-based admin fixture (ROADMAP.md Phase 17) — distinct from
// createTeacher({isAdmin: true}) because login tests need the real
// plaintext password too (the stored hash is one-way). Low bcrypt cost
// factor here purely for test speed; scripts/setAdminPassword.js uses the
// real cost (12) against actual data.
export async function createAdminUser(overrides = {}) {
  const n = nextSeq();
  const plainPassword = overrides.password ?? "correct horse battery staple";
  const passwordHash = await bcrypt.hash(plainPassword, 4);
  const user = await User.create({
    phone: overrides.phone ?? nextPhone(),
    name: overrides.name ?? `Admin ${n}`,
    role: "teacher",
    email: overrides.email ?? `admin${n}@example.com`,
    isAdmin: overrides.isAdmin ?? true,
    password: passwordHash,
  });
  return { user, plainPassword };
}

// Signs the same shape/secret as adminController.adminLogin, without going
// through the real login endpoint (and its rate limiter) when a test only
// needs a valid admin session.
export function signAdminToken(user, opts = {}) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: "admin", isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: "12h", ...opts }
  );
}

// A fresh synthetic client IP per call — the backend's rate limiter buckets
// by IP and lives at module scope for the life of a test file, so tests that
// don't intend to exercise rate limiting must not share one IP by accident.
let ipSeq = 0;
export function nextIp() {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}
