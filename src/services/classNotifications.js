import { sendPushMessages } from "./pushService.js";
import { resolveClassRecipients } from "./notificationScope.js";
import { escapeHtml } from "../utils/validation.js";
import { formatDateTimeInZone } from "../utils/timezone.js";

// Dynamic imports of brevoService/emailTemplates here (not static top-level
// ones) for the same reason adminController.js's sendTeacherWelcomeEmail
// does it — a static import of brevoService.js from a file that's part of
// app.js's module graph broke an unrelated test file's mocked reference to
// the same module (see that file's comment for the reproduction). Deferring
// both imports to call time sidesteps it without touching any working file.
async function sendEmails(entries) {
  const withEmail = entries.filter(({ user }) => user.email);
  if (withEmail.length === 0) return;

  const [{ sendTransactionalEmail }, { renderEmailLayout }] = await Promise.all([
    import("./brevoService.js"),
    import("./emailTemplates.js"),
  ]);

  await Promise.all(
    withEmail.map(({ user, subject, bodyHtml }) =>
      sendTransactionalEmail({
        to: user.email,
        subject,
        htmlContent: renderEmailLayout({ preheader: subject, bodyHtml }),
      }).catch((err) => console.error(`Class notification email to ${user.email} failed:`, err))
    )
  );
}

// Builds one push message and one email per recipient, each with the
// class-time text rendered in that recipient's own timezone (User.timezone)
// — tutor and student in different zones each see their own local time. The
// push goes out as a single batched call; emails are independent sends.
async function notifyEach(users, buildFor) {
  const entries = users.map((user) => ({ user, ...buildFor(user) }));

  const pushMessages = entries
    .filter(({ user }) => user.pushToken && user.notificationsEnabled !== false)
    .map(({ user, title, body, data }) => ({ to: user.pushToken, title, body, data }));
  if (pushMessages.length > 0) await sendPushMessages(pushMessages);

  await sendEmails(entries);
}

// Fired by jobs/classReminders.js once a class is inside a reminder window.
// classDoc is the full doc (subject/scheduledAt already loaded by the
// caller) — recipients still go through resolveClassRecipients rather than
// trusting classDoc.students directly.
export async function notifyClassStarting(classDoc, minutesBefore) {
  try {
    const recipients = await resolveClassRecipients(classDoc._id);
    if (!recipients) return;
    const all = [recipients.tutor, ...recipients.students].filter(Boolean);
    if (all.length === 0) return;

    const title = minutesBefore === 60 ? "Class in 1 hour" : "Class in 30 minutes";

    await notifyEach(all, (user) => {
      const timeLabel = formatDateTimeInZone(classDoc.scheduledAt, user.timezone);
      return {
        subject: title,
        title,
        body: `${classDoc.subject} starts at ${timeLabel}.`,
        data: { classId: classDoc._id.toString(), type: "class-starting" },
        bodyHtml: `
          <p style="margin:0 0 12px;">Just a heads-up — <strong>${escapeHtml(classDoc.subject)}</strong> starts at <strong>${escapeHtml(timeLabel)}</strong>.</p>
          ${classDoc.meetingLink ? `<p style="margin:0;"><a href="${escapeHtml(classDoc.meetingLink)}" style="color:#f472b6;">${escapeHtml(classDoc.meetingLink)}</a></p>` : ""}
        `,
      };
    });
  } catch (err) {
    console.error("Class-starting notification failed:", err);
  }
}

// Fired immediately from classController.updateClassStatus, not on the next
// cron tick — a cancellation/postponement is deliberately real-time, not
// best-effort-eventual like the starting-soon reminders.
export async function notifyClassStatusChange(classDoc, { newScheduledAt } = {}) {
  try {
    const recipients = await resolveClassRecipients(classDoc._id);
    if (!recipients) return;
    const all = [recipients.tutor, ...recipients.students].filter(Boolean);
    if (all.length === 0) return;

    const isCancelled = classDoc.status === "cancelled";
    const title = isCancelled ? "Class cancelled" : "Class postponed";

    await notifyEach(all, (user) => {
      const originalTimeLabel = formatDateTimeInZone(classDoc.scheduledAt, user.timezone);
      let body;
      if (isCancelled) {
        body = `${classDoc.subject} scheduled for ${originalTimeLabel} has been cancelled.`;
      } else if (newScheduledAt) {
        body = `${classDoc.subject} has been postponed to ${formatDateTimeInZone(newScheduledAt, user.timezone)}.`;
      } else {
        body = `${classDoc.subject} has been postponed. New time to be confirmed.`;
      }
      return {
        subject: title,
        title,
        body,
        data: { classId: classDoc._id.toString(), type: "class-status-change" },
        bodyHtml: `<p style="margin:0;">${escapeHtml(body)}</p>`,
      };
    });
  } catch (err) {
    console.error("Class status-change notification failed:", err);
  }
}
