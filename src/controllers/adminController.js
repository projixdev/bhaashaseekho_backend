import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import Enrollment from "../models/Enrollment.js";
import Class from "../models/Class.js";
import Assignment from "../models/Assignment.js";
import TeacherEarning from "../models/TeacherEarning.js";
import { ASSESSMENT_UNLOCK_AFTER_CLASSES } from "./assignmentController.js";
import { MAX_PER_CLASS_CHARGE } from "../constants/earnings.js";
import { validatePhoneInput, normalizePhone, EMAIL_RE, escapeHtml } from "../utils/validation.js";

// Password-based, web-only login for the admin dashboard (ROADMAP.md Phase
// 17) — a second way to authenticate the *same* isAdmin: true User the
// mobile app already knows about via OTP (Phase 15), not a second identity
// system. The resulting token carries role: "admin" (distinct from the
// student/teacher token's role: "student"|"teacher") so it can never
// satisfy requireRole("teacher")/requireRole("student") on the app's
// role-gated routes — see tests/adminDashboard.test.js's cross-contamination
// tests for the two directions this matters.
export async function adminLogin(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password || typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ success: false, message: "Email and password are required." });
      return;
    }

    await connectDB();

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    // Same message whether the email doesn't exist or the password is
    // wrong — doesn't leak which case it was.
    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      res.status(401).json({ success: false, message: "Incorrect email or password." });
      return;
    }

    // Defense in depth: never authenticate a non-admin here, even with a
    // correct password (e.g. a stray/leftover hash on a non-admin doc).
    if (!user.isAdmin) {
      res.status(403).json({ success: false, message: "This account does not have admin access." });
      return;
    }

    const token = jwt.sign({ sub: user._id.toString(), email: user.email, role: "admin", isAdmin: true }, env.jwtSecret, {
      expiresIn: "12h",
    });

    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("POST /api/admin/login failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Shared by every create/edit route below whose email or phone can collide
// with another account (both fields are unique-indexed on User) — reports
// whichever field actually collided instead of assuming it was the phone.
// Returns true (and has already written the response) when it handled a
// duplicate-key error; false means the caller should rethrow/handle it.
function respondDuplicateKeyError(err, res) {
  if (err.code !== 11000) return false;
  const field = err.keyPattern?.email ? "email" : "phone";
  res.status(409).json({
    success: false,
    message:
      field === "email" ? "This email is already registered to another account." : "This phone number is already registered.",
  });
  return true;
}

// The only 3 languages this business teaches (Phase 21) — used to validate
// User.languages on teacher create/edit. Deliberately hardcoded here (unlike
// courseSlug, which stays loose) because this is a closed, small set that's
// part of the actual data model's own enum, not open-ended content that
// lives in the website repo.
const KNOWN_LANGUAGES = ["kannada", "hindi", "telugu"];

function validateLanguages(languages, errors) {
  if (languages === undefined) return undefined;
  if (!Array.isArray(languages)) {
    errors.languages = "Languages must be a list.";
    return undefined;
  }
  const cleaned = [...new Set(languages.map((l) => String(l).trim().toLowerCase()))].filter(Boolean);
  const invalid = cleaned.filter((l) => !KNOWN_LANGUAGES.includes(l));
  if (invalid.length > 0) {
    errors.languages = `Unknown language: ${invalid.join(", ")}.`;
    return undefined;
  }
  return cleaned;
}

// Shared by both createTeacher (below) and scripts/createUser.js's
// --role teacher path — "any teacher profile" gets the same welcome email
// regardless of which one created it, so this isn't duplicated between
// them. Best-effort, same rationale as every other transactional email in
// this app: the account is already safely created, so a delivery hiccup
// here shouldn't be treated as the creation itself having failed.
export async function buildTeacherWelcomeEmailHtml(teacher) {
  const { renderEmailLayout, emailButton, getWhatsAppUrl } = await import("../services/emailTemplates.js");
  const whatsappUrl = getWhatsAppUrl();

  const inner = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(teacher.name)}, you've been added as a teacher on Bhaasha Seekho! Here's how to get started:</p>
    <ol style="margin:0 0 20px; padding-left:20px;">
      <li style="margin-bottom:8px;">Open the Bhaasha Seekho app and log in with your phone number: <strong>${escapeHtml(teacher.phone)}</strong>.</li>
      <li style="margin-bottom:8px;">We'll email a one-time code to this address each time you log in — no password to remember or lose.</li>
      <li>From there you'll see your student roster, can schedule classes, and assign/review homework.</li>
    </ol>
    <p style="margin:0 0 20px;">Questions before your first class? Just reply to this email or reach out below.</p>
    ${whatsappUrl ? `<p style="margin:0 0 8px;">${emailButton("Chat on WhatsApp", whatsappUrl)}</p>` : ""}
    <p style="margin:24px 0 0;">— The Bhaasha Seekho Team</p>
  `;
  return renderEmailLayout({
    preheader: "You've been added as a teacher on Bhaasha Seekho — here's how to log in.",
    eyebrow: "Welcome",
    heading: "You're a Teacher Now",
    bodyHtml: inner,
  });
}

// Dynamic imports (not static top-level ones) for brevoService/
// emailTemplates here are deliberate, not stylistic — a static import of
// brevoService.js specifically from this file breaks Jest's
// unstable_mockModule identity for *other* files that also import it
// (reproduced directly: tests/auth.test.js's own mocked
// sendTransactionalEmail stopped receiving calls the moment this file
// statically imported the same module, with nothing else changed).
// Deferring both imports to call time avoids whatever import-graph-order
// issue causes that, without changing any other file's behavior.
export async function sendTeacherWelcomeEmail(teacher) {
  if (!teacher.email) return;
  try {
    const { sendTransactionalEmail } = await import("../services/brevoService.js");
    await sendTransactionalEmail({
      to: teacher.email,
      subject: "Welcome to Bhaasha Seekho — how to log in",
      htmlContent: await buildTeacherWelcomeEmailHtml(teacher),
    });
  } catch (err) {
    console.error("Teacher welcome email failed:", err);
  }
}

// Moves teacher creation off scripts/createUser.js and into the admin
// dashboard — same fields/defaults as that script's --role teacher path
// (name, phone, role: "teacher", email if given, no password, no
// Enrollment — that block is student-only there too), so a
// dashboard-created teacher is indistinguishable from a CLI-created one.
// One deliberate difference: the script upserts by phone (safe to re-run);
// this route rejects a duplicate phone outright rather than silently
// overwriting an existing account from a web form.
export async function createTeacher(req, res) {
  try {
    const { name, phone, email, languages } = req.body;
    const errors = {};

    if (typeof name !== "string" || !name.trim()) {
      errors.name = "Name is required.";
    } else if (name.trim().length > 120) {
      errors.name = "Name is too long.";
    }

    // Reuses send-otp's own phone-format check (utils/validation.js) rather
    // than a second copy of the same regex.
    const { valid: phoneValid, errors: phoneErrors } = validatePhoneInput({ phone });
    if (!phoneValid) Object.assign(errors, phoneErrors);

    if (email !== undefined && email !== null && email !== "") {
      if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        errors.email = "Please enter a valid email address.";
      } else if (email.trim().length > 160) {
        errors.email = "Email is too long.";
      }
    }

    const validatedLanguages = validateLanguages(languages, errors);

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    await connectDB();

    const normalizedPhone = normalizePhone(phone);
    const normalizedEmail = email ? email.trim().toLowerCase() : undefined;

    let teacher;
    try {
      teacher = await User.create({
        phone: normalizedPhone,
        name: name.trim(),
        role: "teacher",
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(validatedLanguages ? { languages: validatedLanguages } : {}),
      });
    } catch (err) {
      if (respondDuplicateKeyError(err, res)) return;
      throw err;
    }

    await sendTeacherWelcomeEmail(teacher);

    res.status(201).json({
      success: true,
      teacher: { _id: teacher._id, name: teacher.name, phone: teacher.phone, email: teacher.email || null, languages: teacher.languages },
    });
  } catch (err) {
    console.error("POST /api/admin/teachers failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Shared row shape for both the teachers list and the single-teacher detail
// route, so the two can never silently drift into different field sets.
async function buildTeacherRows(teachers) {
  const teacherIds = teachers.map((t) => t._id);

  const [enrollments, classes] = await Promise.all([
    // Active enrollments only — a paused/completed one isn't "currently
    // assigned" for the founder's purposes.
    Enrollment.find({ tutor: { $in: teacherIds }, status: "active" }).select("tutor").lean(),
    Class.find({ tutor: { $in: teacherIds } }).select("tutor status").lean(),
  ]);

  return teachers.map((t) => {
    const idStr = t._id.toString();
    const ownClasses = classes.filter((c) => c.tutor.toString() === idStr);
    return {
      _id: t._id,
      name: t.name,
      phone: t.phone,
      email: t.email || null,
      languages: t.languages ?? [],
      teachableCourses: t.teachableCourses ?? [],
      // A doc written before isActive existed never had it persisted at
      // all (missing key, not false) — same fallback pattern already used
      // for completedClassCount/isTrial below, so a legacy account reads
      // as active rather than silently vanishing behind an "Inactive" badge.
      isActive: t.isActive !== false,
      assignedStudentCount: enrollments.filter((e) => e.tutor.toString() === idStr).length,
      classesScheduled: ownClasses.length,
      classesCompleted: ownClasses.filter((c) => c.status === "completed").length,
    };
  });
}

// Plain find() + JS grouping rather than aggregation pipelines — this is
// founder-scale data (tens of teachers/students), and a readable, easy-to-
// verify query beats a cleverer one nobody asked for.
export async function listAdminTeachers(req, res) {
  try {
    await connectDB();

    // Deactivated teachers stay in this list (the dashboard shows them
    // greyed-out via isActive, not removed) — no isActive filter here.
    const teachers = await User.find({ role: "teacher" })
      .select("name phone email isActive languages teachableCourses")
      .sort({ name: 1 })
      .lean();
    const result = await buildTeacherRows(teachers);

    res.json({ success: true, teachers: result });
  } catch (err) {
    console.error("GET /api/admin/teachers failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function getAdminTeacher(req, res) {
  try {
    await connectDB();

    const teacher = await User.findOne({ _id: req.params.id, role: "teacher" })
      .select("name phone email isActive languages teachableCourses")
      .lean();
    if (!teacher) {
      res.status(404).json({ success: false, message: "Teacher not found." });
      return;
    }

    const [row] = await buildTeacherRows([teacher]);
    res.json({ success: true, teacher: row });
  } catch (err) {
    console.error("GET /api/admin/teachers/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Partial update — only the fields actually present in the body are
// touched. Same validation rules as createTeacher (name/phone required if
// given, email optional-format-checked), plus the same duplicate-phone/
// duplicate-email 409 behavior. email: "" explicitly clears a teacher's
// email (unlike students, below, whose email can never be blank — it's
// their only way to receive a login code).
export async function updateTeacher(req, res) {
  try {
    await connectDB();

    const teacher = await User.findOne({ _id: req.params.id, role: "teacher" });
    if (!teacher) {
      res.status(404).json({ success: false, message: "Teacher not found." });
      return;
    }

    const { name, phone, email, languages } = req.body;
    const errors = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) errors.name = "Name is required.";
      else if (name.trim().length > 120) errors.name = "Name is too long.";
    }
    if (phone !== undefined) {
      const { valid: phoneValid, errors: phoneErrors } = validatePhoneInput({ phone });
      if (!phoneValid) Object.assign(errors, phoneErrors);
    }
    if (email !== undefined && email !== null && email !== "") {
      if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        errors.email = "Please enter a valid email address.";
      } else if (email.trim().length > 160) {
        errors.email = "Email is too long.";
      }
    }
    const validatedLanguages = validateLanguages(languages, errors);

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    const $set = {};
    const $unset = {};
    if (name !== undefined) $set.name = name.trim();
    if (phone !== undefined) $set.phone = normalizePhone(phone);
    if (email !== undefined) {
      if (email) $set.email = email.trim().toLowerCase();
      else $unset.email = "";
    }
    if (validatedLanguages !== undefined) $set.languages = validatedLanguages;

    let updated;
    try {
      updated = await User.findByIdAndUpdate(
        teacher._id,
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
        { returnDocument: "after", runValidators: true }
      );
    } catch (err) {
      if (respondDuplicateKeyError(err, res)) return;
      throw err;
    }

    res.json({
      success: true,
      teacher: {
        _id: updated._id,
        name: updated.name,
        phone: updated.phone,
        email: updated.email || null,
        languages: updated.languages ?? [],
        isActive: updated.isActive !== false,
      },
    });
  } catch (err) {
    console.error("PATCH /api/admin/teachers/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Approves a teacher's pending course request (Phase 22 course discovery) —
// flips that one entry's status to "approved". "Rejected" isn't a status
// value (see User.js's teachableCourses comment — only pending/approved
// exist); rejectTeachableCourse below removes the entry entirely instead of
// storing a permanent rejected record, so the course just reverts to
// requestable.
export async function approveTeachableCourse(req, res) {
  try {
    await connectDB();

    const teacher = await User.findOne({ _id: req.params.id, role: "teacher" });
    if (!teacher) {
      res.status(404).json({ success: false, message: "Teacher not found." });
      return;
    }

    const entry = teacher.teachableCourses.find((c) => c.courseSlug === req.params.courseSlug);
    if (!entry) {
      res.status(404).json({ success: false, message: "No such course request." });
      return;
    }

    entry.status = "approved";
    await teacher.save();

    res.json({ success: true, teachableCourses: teacher.teachableCourses });
  } catch (err) {
    console.error("PATCH /api/admin/teachers/:id/teachable-courses/:courseSlug failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function rejectTeachableCourse(req, res) {
  try {
    await connectDB();

    const teacher = await User.findOne({ _id: req.params.id, role: "teacher" });
    if (!teacher) {
      res.status(404).json({ success: false, message: "Teacher not found." });
      return;
    }

    const before = teacher.teachableCourses.length;
    teacher.teachableCourses = teacher.teachableCourses.filter((c) => c.courseSlug !== req.params.courseSlug);
    if (teacher.teachableCourses.length === before) {
      res.status(404).json({ success: false, message: "No such course request." });
      return;
    }
    await teacher.save();

    res.json({ success: true, teachableCourses: teacher.teachableCourses });
  } catch (err) {
    console.error("DELETE /api/admin/teachers/:id/teachable-courses/:courseSlug failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Soft delete only — a teacher may have Enrollment/Class/Assignment history
// that a hard delete would orphan. Blocked while the teacher still has
// active enrollments unless the caller explicitly passes ?force=true (e.g.
// the founder has already reassigned the roster and just wants the account
// gone from active use). Deactivating never touches those Enrollment docs
// itself — that's a separate, deliberate action, not a side effect here.
export async function deleteTeacher(req, res) {
  try {
    await connectDB();

    const teacher = await User.findOne({ _id: req.params.id, role: "teacher" });
    if (!teacher) {
      res.status(404).json({ success: false, message: "Teacher not found." });
      return;
    }

    if (req.query.force !== "true") {
      const hasActiveEnrollment = await Enrollment.exists({ tutor: teacher._id, status: "active" });
      if (hasActiveEnrollment) {
        res.status(409).json({
          success: false,
          message: "This teacher has active students assigned. Reassign them first, or pass ?force=true to deactivate anyway.",
        });
        return;
      }
    }

    teacher.isActive = false;
    await teacher.save();

    res.json({ success: true, teacher: { _id: teacher._id, name: teacher.name, isActive: false } });
  } catch (err) {
    console.error("DELETE /api/admin/teachers/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// The other half of deactivate — no blocking business rule here the way
// deactivate has (active-enrollment check), since making someone selectable
// again can't strand anything the way deactivating them could.
export async function reactivateTeacher(req, res) {
  try {
    await connectDB();

    const teacher = await User.findOne({ _id: req.params.id, role: "teacher" });
    if (!teacher) {
      res.status(404).json({ success: false, message: "Teacher not found." });
      return;
    }

    teacher.isActive = true;
    await teacher.save();

    res.json({ success: true, teacher: { _id: teacher._id, name: teacher.name, isActive: true } });
  } catch (err) {
    console.error("PATCH /api/admin/teachers/:id/reactivate failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// A trial account gets exactly this long from the moment the admin creates
// it (not from any class date — there's no trial-class-scheduling step in
// this flow) before sendOtp/requireAuth start rejecting it.
export const TRIAL_ACCOUNT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function validateAccountType(accountType, errors) {
  if (accountType !== "trial" && accountType !== "permanent") {
    errors.accountType = 'Account type must be "trial" or "permanent".';
    return null;
  }
  return accountType;
}

// courses: [{courseSlug, tutorId, perClassCharge?, classesRemaining?}] — optional, Phase 21's multi-course Add
// Student flow. courseSlug itself isn't checked against a fixed list here,
// same reasoning as createEnrollment below: the taxonomy (3 languages x 4
// sub-courses) lives in the website's data/courses.js, and the Add Student
// form's own cascading dropdown is what keeps the value sane — this just
// enforces the two things that matter at the data layer: every selected
// course has a tutor (Part 3: never leave Enrollment.tutor null, requiring a
// second manual step), and the same course isn't selected twice in one
// submission (the real unique-index collision this could otherwise hit is
// still caught defensively where the Enrollments are actually created,
// below). Errors are keyed "courses.<index>.<field>" so the form can show
// each bad row inline rather than one generic message.
function validateCourseSelections(courses, errors) {
  if (courses === undefined) return [];
  if (!Array.isArray(courses)) {
    errors.courses = "Courses must be a list.";
    return [];
  }

  const seenSlugs = new Set();
  return courses.map((entry, index) => {
    const courseSlug = typeof entry?.courseSlug === "string" ? entry.courseSlug.trim().toLowerCase() : "";
    const tutorId = typeof entry?.tutorId === "string" ? entry.tutorId.trim() : "";

    if (!courseSlug) errors[`courses.${index}.courseSlug`] = "Course is required.";
    else if (seenSlugs.has(courseSlug)) errors[`courses.${index}.courseSlug`] = "This course was already selected above.";
    seenSlugs.add(courseSlug);

    if (!tutorId) errors[`courses.${index}.tutorId`] = "A tutor is required for every selected course.";

    // The rate is meant to be set at enrollment time, so it's accepted here
    // as well as on the enrollment PATCH. validateMoneyFields writes into a
    // scratch object first so its generic field names can be re-keyed to
    // this row's position, matching how every other per-row error on this
    // endpoint is reported.
    const rowErrors = {};
    const money = validateMoneyFields(entry ?? {}, rowErrors);
    for (const [field, message] of Object.entries(rowErrors)) errors[`courses.${index}.${field}`] = message;

    return { courseSlug, tutorId, ...money };
  });
}

// Admin-created student — the enrollment entry point (ROADMAP.md: the
// website is marketing-only and never creates accounts itself; a visitor
// enrolling on the website only triggers notification emails, not an
// account — this is how they actually become a real, login-capable
// account). Unlike createTeacher, email is required here rather than
// optional: a student's phone is the login identifier but the OTP itself is
// only ever delivered by email (authController.sendOtp), so a student
// created without one can never actually log in until an admin comes back
// to add it. Requiring it up front avoids silently creating a dead-end
// account. accountType is required too — the admin explicitly picks Trial
// (7-day expiring access) or Permanent (no expiry) rather than either
// defaulting silently.
export async function createStudent(req, res) {
  try {
    const { name, phone, email, accountType, courses } = req.body;
    const errors = {};

    if (typeof name !== "string" || !name.trim()) {
      errors.name = "Name is required.";
    } else if (name.trim().length > 120) {
      errors.name = "Name is too long.";
    }

    const { valid: phoneValid, errors: phoneErrors } = validatePhoneInput({ phone });
    if (!phoneValid) Object.assign(errors, phoneErrors);

    if (typeof email !== "string" || !email.trim()) {
      errors.email = "Email is required so the student can receive login codes.";
    } else if (!EMAIL_RE.test(email.trim())) {
      errors.email = "Please enter a valid email address.";
    } else if (email.trim().length > 160) {
      errors.email = "Email is too long.";
    }

    const validatedAccountType = validateAccountType(accountType, errors);
    const cleanedCourses = validateCourseSelections(courses, errors);

    await connectDB();

    // Every tutorId has to resolve to a real, currently-role:"teacher"
    // account — checked before any writes happen (same as the sync checks
    // above) so a bad tutor id never leaves a student created with some
    // courses enrolled and one silently skipped.
    const tutorIds = [...new Set(cleanedCourses.map((c) => c.tutorId).filter(Boolean))];
    const tutors = tutorIds.length > 0 ? await User.find({ _id: { $in: tutorIds }, role: "teacher" }).select("_id name").lean() : [];
    const tutorById = new Map(tutors.map((t) => [t._id.toString(), t]));
    cleanedCourses.forEach((c, index) => {
      if (c.tutorId && !tutorById.has(c.tutorId)) errors[`courses.${index}.tutorId`] = "Selected teacher not found.";
    });

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    const isTrial = validatedAccountType === "trial";

    let student;
    try {
      student = await User.create({
        phone: normalizePhone(phone),
        name: name.trim(),
        role: "student",
        email: email.trim().toLowerCase(),
        isTrial,
        accessExpiresAt: isTrial ? new Date(Date.now() + TRIAL_ACCOUNT_WINDOW_MS) : null,
      });
    } catch (err) {
      if (respondDuplicateKeyError(err, res)) return;
      throw err;
    }

    // The student account already exists at this point — cleanedCourses was
    // fully validated above (every slug unique, every tutor real), so this
    // loop should always succeed; the E11000 catch is defense in depth for
    // the one collision that validation can't rule out (a genuine race),
    // turned into the same clear 409 createEnrollment already uses rather
    // than a raw Mongo error, per Part 3.
    const enrollments = [];
    for (const { courseSlug, tutorId, ...money } of cleanedCourses) {
      const tutor = tutorById.get(tutorId);
      try {
        // money holds only the keys the caller actually sent, so a course
        // added without a rate stays unpriced rather than being written as 0.
        const enrollment = await Enrollment.create({
          student: student._id,
          courseSlug,
          tutor: tutor._id,
          status: "active",
          ...money,
        });
        enrollments.push({
          _id: enrollment._id,
          courseSlug: enrollment.courseSlug,
          tutorId: tutor._id,
          tutorName: tutor.name,
          classesRemaining: enrollment.classesRemaining ?? 0,
          perClassCharge: money.perClassCharge ?? null,
        });
      } catch (err) {
        if (err.code === 11000) {
          res.status(409).json({
            success: false,
            message: `${student.name} is already enrolled in "${courseSlug}".`,
          });
          return;
        }
        throw err;
      }
    }

    res.status(201).json({
      success: true,
      student: {
        _id: student._id,
        name: student.name,
        phone: student.phone,
        email: student.email,
        accountType: student.isTrial ? "trial" : "permanent",
        accessExpiresAt: student.accessExpiresAt,
      },
      enrollments,
    });
  } catch (err) {
    console.error("POST /api/admin/students failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Priority order matters: a student with even one still-"assigned" item is
// "pending" (something outstanding) even if everything else is reviewed;
// "submitted" only once nothing is left pending; "reviewed" only once
// nothing is left pending or awaiting review. Computed across homework and
// assessments together — the admin Students page wants one overall status
// per student, not a separate badge per assignment type.
function overallAssignmentStatus(items) {
  if (items.length === 0) return "none";
  if (items.some((a) => a.status === "assigned")) return "pending";
  if (items.some((a) => a.status === "submitted")) return "submitted";
  return "reviewed";
}

// Shared row shape for both the students list and the single-student detail
// route, mirroring buildTeacherRows above.
async function buildStudentRows(students) {
  const studentIds = students.map((s) => s._id);

  const [assignments, enrollments] = await Promise.all([
    Assignment.find({ student: { $in: studentIds } }).select("student type status").lean(),
    // Active enrollments only — same "currently assigned" definition
    // buildTeacherRows already uses. populate("tutor", "name") since a
    // student can have a different tutor per course and the page needs to
    // show all of them, not just one.
    Enrollment.find({ student: { $in: studentIds }, status: "active" })
      .select("student courseSlug tutor")
      .populate("tutor", "name")
      .lean(),
  ]);

  return students.map((s) => {
    const idStr = s._id.toString();
    const own = assignments.filter((a) => a.student.toString() === idStr);
    const bucket = (type) => {
      const items = own.filter((a) => a.type === type);
      return { assigned: items.length, submitted: items.filter((a) => a.status !== "assigned").length };
    };

    return {
      _id: s._id,
      name: s.name,
      phone: s.phone,
      email: s.email || null,
      // .lean() returns the raw document — a student created before
      // completedClassCount/isTrial/isActive existed never had them
      // actually written, so the key is missing outright, not 0/false.
      // Same fallback assignmentController.js's gate already relies on.
      completedClassCount: s.completedClassCount ?? 0,
      // Exposed explicitly rather than leaving the admin UI to hardcode
      // "10" — same constant the real student-facing gate reads from, not
      // a second copy of the threshold.
      assessmentsUnlockAt: ASSESSMENT_UNLOCK_AFTER_CLASSES,
      assessmentsUnlocked: (s.completedClassCount ?? 0) >= ASSESSMENT_UNLOCK_AFTER_CLASSES,
      homework: bucket("homework"),
      assessments: bucket("assessment"),
      assignmentStatus: overallAssignmentStatus(own),
      teachers: enrollments
        .filter((e) => e.student.toString() === idStr)
        .map((e) => ({ enrollmentId: e._id, courseSlug: e.courseSlug, tutorId: e.tutor?._id ?? null, name: e.tutor?.name ?? null })),
      isTrial: Boolean(s.isTrial),
      accountType: s.isTrial ? "trial" : "permanent",
      accessExpiresAt: s.isTrial ? s.accessExpiresAt : null,
      isActive: s.isActive !== false,
    };
  });
}

export async function listAdminStudents(req, res) {
  try {
    await connectDB();

    // Deactivated students stay in this list too, same as teachers above.
    const students = await User.find({ role: "student" })
      .select("name phone email completedClassCount isTrial accessExpiresAt isActive")
      .sort({ name: 1 })
      .lean();
    const result = await buildStudentRows(students);

    res.json({ success: true, students: result });
  } catch (err) {
    console.error("GET /api/admin/students failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function getAdminStudent(req, res) {
  try {
    await connectDB();

    const student = await User.findOne({ _id: req.params.id, role: "student" })
      .select("name phone email completedClassCount isTrial accessExpiresAt isActive")
      .lean();
    if (!student) {
      res.status(404).json({ success: false, message: "Student not found." });
      return;
    }

    const [row] = await buildStudentRows([student]);
    res.json({ success: true, student: row });
  } catch (err) {
    console.error("GET /api/admin/students/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Partial update — only the fields actually present in the body are
// touched. Unlike updateTeacher, email can never be cleared here (empty
// string is a validation error, not an unset) — a student's only login
// path depends on always having one on file. accountType, when present,
// converts between Trial and Permanent — e.g. the student decides to
// continue after their 7-day trial, so the admin flips them to Permanent
// here and accessExpiresAt is cleared. Flipping *to* Trial always starts a
// fresh 7-day window from the moment of this request, not from the
// account's original creation.
export async function updateStudent(req, res) {
  try {
    await connectDB();

    const student = await User.findOne({ _id: req.params.id, role: "student" });
    if (!student) {
      res.status(404).json({ success: false, message: "Student not found." });
      return;
    }

    const { name, phone, email, accountType } = req.body;
    const errors = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) errors.name = "Name is required.";
      else if (name.trim().length > 120) errors.name = "Name is too long.";
    }
    if (phone !== undefined) {
      const { valid: phoneValid, errors: phoneErrors } = validatePhoneInput({ phone });
      if (!phoneValid) Object.assign(errors, phoneErrors);
    }
    if (email !== undefined) {
      if (typeof email !== "string" || !email.trim()) {
        errors.email = "Email is required so the student can receive login codes.";
      } else if (!EMAIL_RE.test(email.trim())) {
        errors.email = "Please enter a valid email address.";
      } else if (email.trim().length > 160) {
        errors.email = "Email is too long.";
      }
    }
    const validatedAccountType = accountType !== undefined ? validateAccountType(accountType, errors) : undefined;

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    const $set = {};
    if (name !== undefined) $set.name = name.trim();
    if (phone !== undefined) $set.phone = normalizePhone(phone);
    if (email !== undefined) $set.email = email.trim().toLowerCase();
    if (validatedAccountType !== undefined) {
      const isTrial = validatedAccountType === "trial";
      $set.isTrial = isTrial;
      $set.accessExpiresAt = isTrial ? new Date(Date.now() + TRIAL_ACCOUNT_WINDOW_MS) : null;
    }

    let updated;
    try {
      updated = await User.findByIdAndUpdate(student._id, { $set }, { returnDocument: "after", runValidators: true });
    } catch (err) {
      if (respondDuplicateKeyError(err, res)) return;
      throw err;
    }

    res.json({
      success: true,
      student: {
        _id: updated._id,
        name: updated.name,
        phone: updated.phone,
        email: updated.email || null,
        accountType: updated.isTrial ? "trial" : "permanent",
        accessExpiresAt: updated.accessExpiresAt,
        isActive: updated.isActive !== false,
      },
    });
  } catch (err) {
    console.error("PATCH /api/admin/students/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Soft delete only, same reasoning as deleteTeacher — a student may have
// Class/Assignment history a hard delete would orphan. Blocked while the
// student still has an active enrollment unless ?force=true.
export async function deleteStudent(req, res) {
  try {
    await connectDB();

    const student = await User.findOne({ _id: req.params.id, role: "student" });
    if (!student) {
      res.status(404).json({ success: false, message: "Student not found." });
      return;
    }

    if (req.query.force !== "true") {
      const hasActiveEnrollment = await Enrollment.exists({ student: student._id, status: "active" });
      if (hasActiveEnrollment) {
        res.status(409).json({
          success: false,
          message: "This student has an active enrollment. End it first, or pass ?force=true to deactivate anyway.",
        });
        return;
      }
    }

    student.isActive = false;
    await student.save();

    res.json({ success: true, student: { _id: student._id, name: student.name, isActive: false } });
  } catch (err) {
    console.error("DELETE /api/admin/students/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// The other half of deactivate — same reasoning as reactivateTeacher, no
// blocking rule needed since re-enabling a student can't strand anything.
export async function reactivateStudent(req, res) {
  try {
    await connectDB();

    const student = await User.findOne({ _id: req.params.id, role: "student" });
    if (!student) {
      res.status(404).json({ success: false, message: "Student not found." });
      return;
    }

    student.isActive = true;
    await student.save();

    res.json({ success: true, student: { _id: student._id, name: student.name, isActive: true } });
  } catch (err) {
    console.error("PATCH /api/admin/students/:id/reactivate failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Dashboard equivalents of scripts/createUser.js's --course/--tutor flags
// and scripts/assignTutor.js — the "founder teaches the first few classes,
// then hands off to a permanent tutor" workflow those scripts already
// supported CLI-only. Loosely coupled to a fixed course-slug list on
// purpose, same as the scripts and the website: course content lives in
// the website repo, not this database, so this doesn't validate courseSlug
// against a hardcoded enum — the admin dashboard's own dropdown is what
// keeps the value sane, same trust boundary as the CLI already has.
function courseSlugErrors(courseSlug, errors) {
  if (typeof courseSlug !== "string" || !courseSlug.trim()) {
    errors.courseSlug = "Course is required.";
  } else if (courseSlug.trim().length > 60) {
    errors.courseSlug = "Course is too long.";
  }
}

async function findTeacherOrError(tutorId, errors) {
  if (typeof tutorId !== "string" || !tutorId.trim()) {
    errors.tutorId = "Teacher is required.";
    return null;
  }
  const tutor = await User.findOne({ _id: tutorId, role: "teacher" }).select("_id name").lean();
  if (!tutor) errors.tutorId = "Selected teacher not found.";
  return tutor;
}

// The two admin-only money/accounting fields on an Enrollment, validated
// together because they're always set together and their only real rule is
// a relationship between them.
//
// perClassCharge is whole rupees. Integer-only is a correctness choice, not
// a UI preference: it's snapshotted onto every TeacherEarning row and summed
// across hundreds of them on the payout screens, and an integer rate keeps
// every one of those sums exact. null is explicitly allowed and meaningful —
// it clears the rate back to "unpriced", the legitimate state of a free or
// trial enrollment, which the credit hook skips.
//
// classesRemaining is a plain non-negative integer count of sessions the
// student already paid for off-app.
function validateMoneyFields(body, errors) {
  const result = {};

  if (body.perClassCharge !== undefined) {
    const raw = body.perClassCharge;
    // "" and null both mean "unprice this enrollment" — the admin form's
    // empty input and an explicit clear arrive as one or the other.
    if (raw === null || raw === "") {
      result.perClassCharge = null;
    } else {
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        errors.perClassCharge = "Per-class rate must be a whole number of rupees above 0.";
      } else if (value > MAX_PER_CLASS_CHARGE) {
        errors.perClassCharge = `Per-class rate can't be above ₹${MAX_PER_CLASS_CHARGE.toLocaleString("en-IN")}.`;
      } else {
        result.perClassCharge = value;
      }
    }
  }

  if (body.classesRemaining !== undefined) {
    const value = Number(body.classesRemaining);
    if (!Number.isInteger(value) || value < 0) {
      errors.classesRemaining = "Classes remaining must be a whole number, 0 or more.";
    } else {
      result.classesRemaining = value;
    }
  }

  return result;
}

// A student's enrollments with the admin-only fields attached — the read
// side of the pricing panel. Deliberately its own route rather than folded
// into GET /api/admin/students/:id: that row shape is shared with the
// students *list*, and widening it would put perClassCharge into a response
// used in more places than this one page needs. Keeping the rate behind a
// single, explicitly-requested admin route is the whole point of the
// select: false on the field.
export async function listEnrollments(req, res) {
  try {
    await connectDB();

    const { studentId } = req.query;
    if (!studentId || !mongoose.isValidObjectId(studentId)) {
      res.status(400).json({ success: false, message: "studentId is required." });
      return;
    }

    const enrollments = await Enrollment.find({ student: studentId })
      .select("+perClassCharge")
      .populate("tutor", "name")
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      success: true,
      enrollments: enrollments.map((e) => ({
        _id: e._id,
        courseSlug: e.courseSlug,
        batchType: e.batchType,
        status: e.status,
        tutorId: e.tutor?._id ?? null,
        tutorName: e.tutor?.name ?? null,
        classesRemaining: e.classesRemaining ?? 0,
        // undefined (a doc written before the field existed) reads back as
        // null — "no rate set", the same state an explicit clear produces.
        perClassCharge: e.perClassCharge ?? null,
      })),
    });
  } catch (err) {
    console.error("GET /api/admin/enrollments failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Enrolls a student in a course with a chosen tutor — upserts on
// (student, courseSlug) rather than rejecting a duplicate outright,
// matching createUser.js's own re-run-safe behavior: re-"enrolling" in a
// course a student is already in just updates who teaches it, same as
// reassignEnrollmentTutor below would, rather than erroring.
export async function createEnrollment(req, res) {
  try {
    await connectDB();

    const student = await User.findOne({ _id: req.params.id, role: "student" });
    if (!student) {
      res.status(404).json({ success: false, message: "Student not found." });
      return;
    }

    const { courseSlug, tutorId } = req.body;
    const errors = {};
    courseSlugErrors(courseSlug, errors);
    const tutor = await findTeacherOrError(tutorId, errors);
    // Enrollment time is when the per-student rate is meant to be set, so
    // both fields are accepted here as well as on the PATCH below. Both stay
    // optional: an admin who doesn't know the rate yet enrolls now and
    // prices later, and the credit hook simply skips an unpriced enrollment
    // until they do.
    const money = validateMoneyFields(req.body, errors);

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    const enrollment = await Enrollment.findOneAndUpdate(
      { student: student._id, courseSlug: courseSlug.trim().toLowerCase() },
      {
        student: student._id,
        courseSlug: courseSlug.trim().toLowerCase(),
        tutor: tutor._id,
        status: "active",
        // Spread last, and only ever containing keys the caller actually
        // sent — re-enrolling in an existing course (this is an upsert, see
        // above) must not silently wipe a rate that's already set.
        ...money,
      },
      { upsert: true, returnDocument: "after" }
    ).select("+perClassCharge"); // opt in explicitly, or the rate below reads back undefined

    res.status(201).json({
      success: true,
      enrollment: {
        _id: enrollment._id,
        courseSlug: enrollment.courseSlug,
        tutorId: tutor._id,
        tutorName: tutor.name,
        classesRemaining: enrollment.classesRemaining ?? 0,
        // Read off the stored document rather than echoed from the request,
        // so re-enrolling without sending a rate reports the rate the
        // enrollment actually still has instead of a misleading null.
        perClassCharge: enrollment.perClassCharge ?? null,
      },
    });
  } catch (err) {
    console.error("POST /api/admin/students/:id/enrollments failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Partial update of one enrollment — the tutor handoff step, plus the
// per-student rate and remaining-class count.
//
// Tutor reassignment doesn't touch Class/Assignment history at all: GET
// /api/classes already shows a student every class they've had regardless
// of which tutor taught it, so past classes and the newly-assigned tutor's
// future ones just show up together, in order (same guarantee
// scripts/assignTutor.js documents). It doesn't touch TeacherEarning history
// either, for the same reason and a stronger one — those rows are settled
// payout records for work someone already did, so they stay with the teacher
// who earned them.
//
// Every field is optional and only what's present in the body is written,
// so the existing { tutorId } call from the dashboard's reassign control
// behaves exactly as it did before pricing existed.
export async function updateEnrollment(req, res) {
  try {
    await connectDB();

    const enrollment = await Enrollment.findById(req.params.id).select("+perClassCharge");
    if (!enrollment) {
      res.status(404).json({ success: false, message: "Enrollment not found." });
      return;
    }

    // Every field is optional individually, but a body naming none of them
    // is a caller bug, not a no-op worth answering 200 to — the pre-pricing
    // version of this route rejected exactly that case (as a missing
    // tutorId) and it stays rejected now that there are three ways to
    // satisfy it.
    const UPDATABLE = ["tutorId", "perClassCharge", "classesRemaining"];
    if (!UPDATABLE.some((field) => req.body[field] !== undefined)) {
      res.status(400).json({ success: false, message: "Nothing to update." });
      return;
    }

    const errors = {};
    const tutor = req.body.tutorId !== undefined ? await findTeacherOrError(req.body.tutorId, errors) : null;
    const money = validateMoneyFields(req.body, errors);

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    if (tutor) enrollment.tutor = tutor._id;
    if (money.perClassCharge !== undefined) enrollment.perClassCharge = money.perClassCharge;
    if (money.classesRemaining !== undefined) enrollment.classesRemaining = money.classesRemaining;
    await enrollment.save();

    // Not a validation error, deliberately. Sessions with no rate is a real
    // state (a comped or trial package), so blocking it would be wrong —
    // but it's also the state where a teacher silently earns nothing for
    // every class they teach against it, which an admin should be told
    // about rather than discover on a payout run. The dashboard renders
    // this as an inline warning next to the row.
    const warning =
      enrollment.classesRemaining > 0 && !enrollment.perClassCharge
        ? "This enrollment has classes remaining but no per-class rate, so its teacher earns nothing for them."
        : null;

    res.json({
      success: true,
      warning,
      enrollment: {
        _id: enrollment._id,
        courseSlug: enrollment.courseSlug,
        tutorId: enrollment.tutor,
        tutorName: tutor ? tutor.name : undefined,
        classesRemaining: enrollment.classesRemaining ?? 0,
        perClassCharge: enrollment.perClassCharge ?? null,
      },
    });
  } catch (err) {
    console.error("PATCH /api/admin/enrollments/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Removing a course entirely (Phase 21 Part 4) — a hard delete, unlike the
// soft-delete used for User docs. There's no history on Enrollment itself
// worth preserving: Class and Assignment records reference the student/
// tutor Users directly, not the Enrollment id, so a student's past classes
// and assignments stay intact and visible either way (same guarantee
// reassignEnrollmentTutor's comment above already relies on).
export async function deleteEnrollment(req, res) {
  try {
    await connectDB();

    const enrollment = await Enrollment.findById(req.params.id);
    if (!enrollment) {
      res.status(404).json({ success: false, message: "Enrollment not found." });
      return;
    }

    await enrollment.deleteOne();

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/admin/enrollments/:id failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Cross-teacher payout view. Two shapes in one response because the page
// needs both at once: `teachers` is the per-teacher roll-up the table
// renders, `entries` is the ledger itself for the expanded row / CSV export.
//
// Both totals come straight from TeacherEarning rather than a cached
// counter on User. The ledger is the only record of what was actually
// earned, so deriving from it means the number on the payout screen and the
// rows it's a sum of can never disagree — there's no second copy to drift,
// and no reconcile step to remember to run. At this scale (tens of teachers)
// it's one indexed $group.
//
// ?teacherId= and ?status= narrow the entry list only; the roll-up stays
// across every teacher so the page header totals don't move when a filter
// is applied.
export async function listEarnings(req, res) {
  try {
    await connectDB();

    const { teacherId, status } = req.query;
    if (status !== undefined && status !== "pending" && status !== "paid") {
      res.status(400).json({ success: false, message: 'status must be "pending" or "paid".' });
      return;
    }

    if (teacherId !== undefined && !mongoose.isValidObjectId(teacherId)) {
      res.status(400).json({ success: false, message: "Invalid teacherId." });
      return;
    }

    const entryFilter = {};
    if (teacherId) entryFilter.teacher = teacherId;
    if (status) entryFilter.status = status;

    const [totals, entries, teachers] = await Promise.all([
      TeacherEarning.aggregate([
        { $group: { _id: { teacher: "$teacher", status: "$status" }, points: { $sum: "$points" }, count: { $sum: 1 } } },
      ]),
      TeacherEarning.find(entryFilter)
        .sort({ createdAt: -1 })
        // Hard cap rather than true pagination: this is a founder-scale
        // dashboard, and a bounded response is what keeps the page honest
        // about it. The roll-up above is unbounded and always exact, so the
        // totals stay right even when the entry list is truncated.
        .limit(500)
        .populate("teacher", "name")
        .populate("student", "name")
        .lean(),
      User.find({ role: "teacher" }).select("name isActive").sort({ name: 1 }).lean(),
    ]);

    const byTeacher = new Map(
      teachers.map((t) => [
        t._id.toString(),
        { _id: t._id, name: t.name, isActive: t.isActive !== false, pointsPending: 0, pointsPaid: 0, entryCount: 0 },
      ])
    );

    for (const row of totals) {
      const teacher = byTeacher.get(row._id.teacher.toString());
      // A teacher whose account was hard-deleted still has ledger rows;
      // skipping them here keeps the roll-up aligned with the teacher list
      // the table renders, and the entries below still carry the history.
      if (!teacher) continue;
      if (row._id.status === "paid") teacher.pointsPaid = row.points;
      else teacher.pointsPending = row.points;
      teacher.entryCount += row.count;
    }

    res.json({
      success: true,
      teachers: [...byTeacher.values()].map((t) => ({ ...t, pointsLifetime: t.pointsPending + t.pointsPaid })),
      entries: entries.map(buildEarningRow),
    });
  } catch (err) {
    console.error("GET /api/admin/earnings failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

// Shared row shape for the admin entry list and the CSV the dashboard
// builds from it, so the two can't drift.
function buildEarningRow(e) {
  return {
    _id: e._id,
    teacherId: e.teacher?._id ?? e.teacher,
    teacherName: e.teacher?.name ?? null,
    studentName: e.student?.name ?? null,
    courseSlug: e.courseSlug,
    classId: e.classId,
    chargedAmount: e.chargedAmount,
    points: e.points,
    status: e.status,
    paidAt: e.paidAt,
    createdAt: e.createdAt,
  };
}

const MAX_SETTLE_BATCH = 500;

// Marks a batch of ledger rows paid — the payout actually happens off-app
// (bank transfer/UPI), this records that it did.
//
// Idempotent by construction: the filter includes status "pending", so
// re-sending the same entryIds (a double-click, a retried request, two
// admins settling the same batch at once) matches zero documents the second
// time and settles nothing twice. `settled` is what the update really
// changed, not what was asked for, so the caller sees the difference.
//
// There is no counter to move and no sum to recompute — pending and paid
// totals are derived from these rows, so flipping status is the entire
// operation and it can't leave two numbers disagreeing. teacherId is
// required and part of the filter: it scopes the write so a stray id from
// another teacher's list can't be settled into this batch by accident.
export async function settleEarnings(req, res) {
  try {
    await connectDB();

    const { teacherId, entryIds } = req.body;
    // Shape-checked here rather than left to Mongoose's cast error, so a
    // malformed id is a clean 400 instead of a 500 out of the $match below.
    if (!teacherId || typeof teacherId !== "string" || !mongoose.isValidObjectId(teacherId)) {
      res.status(400).json({ success: false, message: "teacherId is required." });
      return;
    }
    if (Array.isArray(entryIds) && entryIds.some((id) => !mongoose.isValidObjectId(id))) {
      res.status(400).json({ success: false, message: "One or more selected entries are invalid." });
      return;
    }
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      res.status(400).json({ success: false, message: "Select at least one entry to settle." });
      return;
    }
    if (entryIds.length > MAX_SETTLE_BATCH) {
      res.status(400).json({ success: false, message: `Settle at most ${MAX_SETTLE_BATCH} entries at a time.` });
      return;
    }

    const paidAt = new Date();
    const result = await TeacherEarning.updateMany(
      { _id: { $in: entryIds }, teacher: teacherId, status: "pending" },
      { $set: { status: "paid", paidAt } }
    );

    // Recomputed after the write, from the ledger, so the response carries
    // the teacher's real post-settlement position rather than an arithmetic
    // guess the client would then have to trust.
    const totals = await TeacherEarning.aggregate([
      { $match: { teacher: new mongoose.Types.ObjectId(teacherId) } },
      { $group: { _id: "$status", points: { $sum: "$points" } } },
    ]);
    const pointsPaid = totals.find((t) => t._id === "paid")?.points ?? 0;
    const pointsPending = totals.find((t) => t._id === "pending")?.points ?? 0;

    res.json({ success: true, settled: result.modifiedCount, paidAt, pointsPending, pointsPaid });
  } catch (err) {
    console.error("PATCH /api/admin/earnings/settle failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
