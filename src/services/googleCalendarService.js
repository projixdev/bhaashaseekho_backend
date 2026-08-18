import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { env } from "../config/env.js";

// Service-account auth, not the OAuth user-consent flow — link generation
// can't depend on any human staying logged in (Phase 19 brief). The service
// account's own calendar (GOOGLE_CALENDAR_ID) is what events get created
// on; share that calendar with the service account's email first (see
// README/setup notes) or every call below fails with a 404.
//
// `subject` makes this a domain-wide-delegated request impersonating a real
// Workspace user, rather than the bare service-account identity — required
// specifically for Meet conference creation. Plain event insert/patch/
// delete work without it, but Google rejects conferenceData.createRequest
// with "Invalid conference type value" from an unimpersonated service
// account, no matter what calendar-sharing permissions are granted. The
// Workspace admin also has to explicitly authorize this service account for
// domain-wide delegation (Admin Console -> Security -> API controls ->
// Domain-wide delegation) before impersonation itself is accepted.
function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: env.googleServiceAccountEmail,
    key: env.googleServiceAccountPrivateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
    subject: env.googleWorkspaceUserEmail,
  });
  return google.calendar({ version: "v3", auth });
}

function toEventTimes(scheduledAt, durationMinutes) {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return {
    start: { dateTime: start.toISOString(), timeZone: "Asia/Kolkata" },
    end: { dateTime: end.toISOString(), timeZone: "Asia/Kolkata" },
  };
}

// No attendees on the event on purpose — Enrollment-based scoping already
// controls who sees this class in-app; we're not layering Google's own
// calendar-invite access control on top of that (Phase 19 brief, Part 1.2).
// Throws on any failure — callers must not save a class with an empty
// meetingLink, so there's nothing to catch-and-default here.
export async function createMeetEvent({ subject, scheduledAt, durationMinutes }) {
  const calendar = getCalendarClient();

  const response = await calendar.events.insert({
    calendarId: env.googleCalendarId,
    conferenceDataVersion: 1,
    requestBody: {
      summary: subject,
      ...toEventTimes(scheduledAt, durationMinutes),
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const meetingLink = response.data.hangoutLink;
  const eventId = response.data.id;
  if (!meetingLink || !eventId) {
    throw new Error("Google Calendar did not return a Meet link for the new event.");
  }
  return { meetingLink, eventId };
}

// Reschedule (postpone-with-a-new-time) — only start/end move; the Meet
// link/conference data stays attached to the same event, so meetingLink on
// the Class doc doesn't need to change.
export async function updateMeetEventTime(eventId, { scheduledAt, durationMinutes }) {
  const calendar = getCalendarClient();
  await calendar.events.patch({
    calendarId: env.googleCalendarId,
    eventId,
    requestBody: toEventTimes(scheduledAt, durationMinutes),
  });
}

// Cancel — the event is deleted outright rather than left behind at its now
// wrong time (Phase 19 brief: "so links don't go stale"). Google returns 410
// Gone if the event was already deleted (e.g. a retry after a prior success)
// — treated as success, not an error, since the end state is identical.
export async function deleteMeetEvent(eventId) {
  const calendar = getCalendarClient();
  try {
    await calendar.events.delete({ calendarId: env.googleCalendarId, eventId });
  } catch (err) {
    if (err.code === 410 || err.code === 404) return;
    throw err;
  }
}
