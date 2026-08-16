import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import Enrollment from "../models/Enrollment.js";
import Class from "../models/Class.js";
import Assignment from "../models/Assignment.js";
import { ASSESSMENT_UNLOCK_AFTER_CLASSES } from "./assignmentController.js";
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
    const { name, phone, email } = req.body;
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
      });
    } catch (err) {
      if (respondDuplicateKeyError(err, res)) return;
      throw err;
    }

    await sendTeacherWelcomeEmail(teacher);

    res.status(201).json({
      success: true,
      teacher: { _id: teacher._id, name: teacher.name, phone: teacher.phone, email: teacher.email || null },
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
    const teachers = await User.find({ role: "teacher" }).select("name phone email isActive").sort({ name: 1 }).lean();
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
      .select("name phone email isActive")
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

    const { name, phone, email } = req.body;
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
      teacher: { _id: updated._id, name: updated.name, phone: updated.phone, email: updated.email || null, isActive: updated.isActive !== false },
    });
  } catch (err) {
    console.error("PATCH /api/admin/teachers/:id failed:", err);
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
    const { name, phone, email, accountType } = req.body;
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

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }

    await connectDB();

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
        .map((e) => ({ courseSlug: e.courseSlug, name: e.tutor?.name ?? null })),
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
