import { sendPushNotifications } from "./pushService.js";
import { resolveClassRecipients } from "./notificationScope.js";
import { escapeHtml } from "../utils/validation.js";

function formatClassTime(date) {
  return new Date(date).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

async function pushToAll(users, payload) {
  const tokens = users
    .filter(Boolean)
    .filter((u) => u.notificationsEnabled !== false)
    .map((u) => u.pushToken)
    .filter(Boolean);
  if (tokens.length === 0) return;
  await sendPushNotifications(tokens, payload);
}

// Dynamic imports of brevoService/emailTemplates here (not static top-level
// ones) for the same reason adminController.js's sendTeacherWelcomeEmail
// does it — a static import of brevoService.js from a file that's part of
// app.js's module graph broke an unrelated test file's mocked reference to
// the same module (see that file's comment for the reproduction). Deferring
// both imports to call time sidesteps it without touching any working file.
async function emailAll(users, { subject, buildBodyHtml }) {
  const recipients = users.filter(Boolean).filter((u) => u.email);
  if (recipients.length === 0) return;

  const [{ sendTransactionalEmail }, { renderEmailLayout }] = await Promise.all([
    import("./brevoService.js"),
    import("./emailTemplates.js"),
  ]);

  await Promise.all(
    recipients.map((user) =>
      sendTransactionalEmail({
        to: user.email,
        subject,
        htmlContent: renderEmailLayout({ preheader: subject, bodyHtml: buildBodyHtml(user) }),
      }).catch((err) => console.error(`Class notification email to ${user.email} failed:`, err))
    )
  );
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

    const timeLabel = formatClassTime(classDoc.scheduledAt);
    const title = minutesBefore === 60 ? "Class in 1 hour" : "Class in 30 minutes";
    const body = `${classDoc.subject} starts at ${timeLabel}.`;

    await pushToAll(all, { title, body, data: { classId: classDoc._id.toString(), type: "class-starting" } });

    await emailAll(all, {
      subject: title,
      buildBodyHtml: () => `
        <p style="margin:0 0 12px;">Just a heads-up — <strong>${escapeHtml(classDoc.subject)}</strong> starts at <strong>${escapeHtml(timeLabel)}</strong>.</p>
        ${classDoc.meetingLink ? `<p style="margin:0;"><a href="${escapeHtml(classDoc.meetingLink)}" style="color:#f472b6;">${escapeHtml(classDoc.meetingLink)}</a></p>` : ""}
      `,
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
    const originalTimeLabel = formatClassTime(classDoc.scheduledAt);

    let body;
    if (isCancelled) {
      body = `${classDoc.subject} scheduled for ${originalTimeLabel} has been cancelled.`;
    } else if (newScheduledAt) {
      body = `${classDoc.subject} has been postponed to ${formatClassTime(newScheduledAt)}.`;
    } else {
      body = `${classDoc.subject} has been postponed. New time to be confirmed.`;
    }

    await pushToAll(all, { title, body, data: { classId: classDoc._id.toString(), type: "class-status-change" } });

    await emailAll(all, {
      subject: title,
      buildBodyHtml: () => `<p style="margin:0;">${escapeHtml(body)}</p>`,
    });
  } catch (err) {
    console.error("Class status-change notification failed:", err);
  }
}
