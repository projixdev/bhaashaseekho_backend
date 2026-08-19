import { sendPushNotifications } from "./pushService.js";
import { resolveAssignmentRecipients } from "./notificationScope.js";
import { escapeHtml } from "../utils/validation.js";

function assignmentLabel(assignment) {
  return assignment.type === "assessment" ? "Assessment" : "Homework";
}

async function pushTo(user, payload) {
  if (!user?.pushToken || user.notificationsEnabled === false) return;
  await sendPushNotifications([user.pushToken], payload);
}

// Same dynamic-import-at-call-time pattern as classNotifications.js and
// adminController.js's sendTeacherWelcomeEmail — see either's comment for
// why (a static top-level import of brevoService.js from a file in app.js's
// module graph broke an unrelated test's mocked reference to it).
async function emailTo(user, { subject, bodyHtml }) {
  if (!user?.email) return;
  const [{ sendTransactionalEmail }, { renderEmailLayout }] = await Promise.all([
    import("./brevoService.js"),
    import("./emailTemplates.js"),
  ]);
  await sendTransactionalEmail({
    to: user.email,
    subject,
    htmlContent: renderEmailLayout({ preheader: subject, bodyHtml }),
  }).catch((err) => console.error(`Assignment notification email to ${user.email} failed:`, err));
}

// Fired from assignmentController.createAssignment — student only, per the
// phase brief ("push + email to the target student(s) only"). Homework and
// assessment share this one trigger since they share one endpoint; copy just
// reflects which type it was.
export async function notifyAssignmentAssigned(assignment) {
  try {
    const recipients = await resolveAssignmentRecipients(assignment._id);
    if (!recipients?.student) return;
    const { student, tutor } = recipients;
    const label = assignmentLabel(assignment);
    const tutorName = tutor?.name || "Your tutor";

    await pushTo(student, {
      title: `New ${label.toLowerCase()}`,
      body: `${tutorName} assigned "${assignment.title}".`,
      data: { assignmentId: assignment._id.toString(), type: "assignment-assigned" },
    });

    const dueLine = assignment.dueDate
      ? ` — due ${new Date(assignment.dueDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}`
      : "";
    await emailTo(student, {
      subject: `New ${label}: ${assignment.title}`,
      bodyHtml: `<p style="margin:0;">${escapeHtml(tutorName)} assigned "<strong>${escapeHtml(assignment.title)}</strong>" to you${escapeHtml(dueLine)}.</p>`,
    });
  } catch (err) {
    console.error("Assignment-assigned notification failed:", err);
  }
}

// Fired from assignmentController.submitAssignment — tutor only ("uploaded
// by student: push + email to their tutor only"). Covers both homework and
// assessment submissions, same endpoint either way.
export async function notifyAssignmentSubmitted(assignment) {
  try {
    const recipients = await resolveAssignmentRecipients(assignment._id);
    if (!recipients?.tutor) return;
    const { student, tutor } = recipients;
    const studentName = student?.name || "A student";

    await pushTo(tutor, {
      title: "New submission",
      body: `${studentName} submitted "${assignment.title}".`,
      data: { assignmentId: assignment._id.toString(), type: "assignment-submitted" },
    });

    await emailTo(tutor, {
      subject: `New submission: ${assignment.title}`,
      bodyHtml: `<p style="margin:0;">${escapeHtml(studentName)} submitted "<strong>${escapeHtml(assignment.title)}</strong>" for review.</p>`,
    });
  } catch (err) {
    console.error("Assignment-submitted notification failed:", err);
  }
}

// Fired from assignmentController.reviewAssignment — student only.
export async function notifyAssignmentReviewed(assignment) {
  try {
    const recipients = await resolveAssignmentRecipients(assignment._id);
    if (!recipients?.student) return;
    const { student } = recipients;

    await pushTo(student, {
      title: "Your submission was reviewed",
      body: `"${assignment.title}" has been reviewed — score: ${assignment.score}.`,
      data: { assignmentId: assignment._id.toString(), type: "assignment-reviewed" },
    });

    await emailTo(student, {
      subject: `Reviewed: ${assignment.title}`,
      bodyHtml: `<p style="margin:0;">"<strong>${escapeHtml(assignment.title)}</strong>" has been reviewed. Score: <strong>${escapeHtml(assignment.score)}</strong>.</p>`,
    });
  } catch (err) {
    console.error("Assignment-reviewed notification failed:", err);
  }
}
