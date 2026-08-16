import Class from "../models/Class.js";
import Assignment from "../models/Assignment.js";
import Enrollment from "../models/Enrollment.js";
import User from "../models/User.js";

// Class and Assignment don't carry a courseSlug of their own (subject is
// free text, and Enrollment's courseSlug is the only place that's tracked) —
// so the cross-check that actually matters, and the one both callers below
// share, is "does this exact tutor+student pair have an active Enrollment at
// all," same authorization rule createClass/createAssignment already enforce
// at creation time. This is a second, independent check at notify time, not
// a re-trust of whatever's already on the Class/Assignment doc — a student
// id that's merely sitting in Class.students (stale data, a bug elsewhere)
// without a matching active Enrollment is deliberately excluded.
async function activeEnrollmentStudentIds(tutorId, studentIds) {
  if (!studentIds || studentIds.length === 0) return new Set();
  const enrollments = await Enrollment.find({
    tutor: tutorId,
    student: { $in: studentIds },
    status: "active",
  })
    .select("student")
    .lean();
  return new Set(enrollments.map((e) => e.student.toString()));
}

const RECIPIENT_FIELDS = "name email pushToken";

// The single source of truth for "who is allowed to hear about this class" —
// every class-related notification (starting-soon reminders, cancel/postpone)
// goes through this instead of re-deriving recipients inline, so there's
// exactly one place that scoping bug could ever hide.
export async function resolveClassRecipients(classId) {
  const cls = await Class.findById(classId).select("tutor students").lean();
  if (!cls) return null;

  const allowedIds = await activeEnrollmentStudentIds(cls.tutor, cls.students);
  const scopedIds = cls.students.map((id) => id.toString()).filter((id) => allowedIds.has(id));

  const [tutor, students] = await Promise.all([
    User.findById(cls.tutor).select(RECIPIENT_FIELDS).lean(),
    User.find({ _id: { $in: scopedIds } })
      .select(RECIPIENT_FIELDS)
      .lean(),
  ]);

  return { tutor, students };
}

// Assignment recipients are always exactly its own student + tutor — there's
// no array to filter down, but the same active-Enrollment cross-check still
// applies (an assignment left over from a since-ended enrollment shouldn't
// keep generating notifications either).
export async function resolveAssignmentRecipients(assignmentId) {
  const assignment = await Assignment.findById(assignmentId).select("tutor student").lean();
  if (!assignment) return null;

  const allowedIds = await activeEnrollmentStudentIds(assignment.tutor, [assignment.student]);
  if (!allowedIds.has(assignment.student.toString())) {
    return { tutor: null, student: null };
  }

  const [tutor, student] = await Promise.all([
    User.findById(assignment.tutor).select(RECIPIENT_FIELDS).lean(),
    User.findById(assignment.student).select(RECIPIENT_FIELDS).lean(),
  ]);

  return { tutor, student };
}
