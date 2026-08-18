// Phase 18: class-starting/cancel/postpone push + email, strictly scoped via
// Enrollment. Split into three concerns: resolveClassRecipients' scoping
// guarantee (the mandatory "never notify an outsider" case), the reminder
// cron tick's idempotency, and the cancel/postpone endpoint firing
// immediately rather than waiting for the next tick.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, createClass, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

jest.unstable_mockModule("../src/services/googleCalendarService.js", () => ({
  createMeetEvent: jest.fn(),
  updateMeetEventTime: jest.fn().mockResolvedValue(undefined),
  deleteMeetEvent: jest.fn().mockResolvedValue(undefined),
}));

const { default: app } = await import("../src/app.js");
const { default: Class } = await import("../src/models/Class.js");
const { resolveClassRecipients } = await import("../src/services/notificationScope.js");
const { runClassReminderTick } = await import("../src/jobs/classReminders.js");
const { sendTransactionalEmail } = await import("../src/services/brevoService.js");
const { updateMeetEventTime, deleteMeetEvent } = await import("../src/services/googleCalendarService.js");

beforeAll(connectTestDB);
afterEach(() => {
  jest.restoreAllMocks();
  sendTransactionalEmail.mockClear();
  updateMeetEventTime.mockClear().mockResolvedValue(undefined);
  deleteMeetEvent.mockClear().mockResolvedValue(undefined);
  return clearTestDB();
});
afterAll(disconnectTestDB);

async function withPushToken(user, token) {
  const { default: User } = await import("../src/models/User.js");
  await User.findByIdAndUpdate(user._id, { pushToken: token, email: user.email || `${user._id}@example.com` });
}

describe("resolveClassRecipients — scoping", () => {
  test("mandatory: a class scheduled for Teacher1/Stu1 never includes Stu3, even though Stu3 shares the same courseSlug under Teacher2", async () => {
    const teacher1 = await createTeacher({ name: "Teacher1" });
    const teacher2 = await createTeacher({ name: "Teacher2" });
    const stu1 = await createStudent({ name: "Stu1" });
    const stu2 = await createStudent({ name: "Stu2" });
    const stu3 = await createStudent({ name: "Stu3" });
    await createEnrollment({ student: stu1, tutor: teacher1, courseSlug: "kannada" });
    await createEnrollment({ student: stu2, tutor: teacher1, courseSlug: "kannada" });
    await createEnrollment({ student: stu3, tutor: teacher2, courseSlug: "kannada" });

    const cls = await createClass({ tutor: teacher1, students: [stu1], scheduledAt: new Date() });

    const recipients = await resolveClassRecipients(cls._id);

    const ids = recipients.students.map((s) => s._id.toString());
    expect(ids).toEqual([stu1._id.toString()]);
    expect(ids).not.toContain(stu3._id.toString());
    expect(recipients.tutor._id.toString()).toBe(teacher1._id.toString());
  });

  test("defense in depth: a student id sitting in Class.students without a matching active Enrollment is excluded, not trusted", async () => {
    const teacher = await createTeacher();
    const enrolled = await createStudent();
    const stale = await createStudent(); // never enrolled with this teacher at all
    await createEnrollment({ student: enrolled, tutor: teacher });

    const cls = await createClass({ tutor: teacher, students: [enrolled, stale], scheduledAt: new Date() });

    const recipients = await resolveClassRecipients(cls._id);
    expect(recipients.students.map((s) => s._id.toString())).toEqual([enrolled._id.toString()]);
  });

  test("a paused (non-active) enrollment is excluded too", async () => {
    const { default: Enrollment } = await import("../src/models/Enrollment.js");
    const teacher = await createTeacher();
    const student = await createStudent();
    const enrollment = await createEnrollment({ student, tutor: teacher });
    await Enrollment.findByIdAndUpdate(enrollment._id, { status: "paused" });

    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date() });

    const recipients = await resolveClassRecipients(cls._id);
    expect(recipients.students).toEqual([]);
  });
});

describe("runClassReminderTick — time-based 60/30 min reminders", () => {
  test("a class 60 minutes out gets the 60min push+email and is marked in notificationsSent", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await withPushToken(teacher, "tutor-token");
    await withPushToken(student, "student-token");

    const now = new Date();
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(now.getTime() + 60 * 60 * 1000) });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const result = await runClassReminderTick(now);

    expect(result.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pushedTokens = JSON.parse(fetchMock.mock.calls[0][1].body).map((m) => m.to);
    expect(pushedTokens.sort()).toEqual(["student-token", "tutor-token"]);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);

    const reloaded = await Class.findById(cls._id);
    expect(reloaded.notificationsSent).toEqual(["60min"]);
  });

  test("outside the tolerance window → not reminded, not marked", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await withPushToken(teacher, "tutor-token");

    const now = new Date();
    // 10 minutes outside the 60min window's ±2min tolerance.
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(now.getTime() + 70 * 60 * 1000) });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    const result = await runClassReminderTick(now);

    expect(result.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await Class.findById(cls._id)).notificationsSent).toEqual([]);
  });

  test("already-marked class is skipped on a later tick — no duplicate send", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await withPushToken(teacher, "tutor-token");

    const now = new Date();
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(now.getTime() + 60 * 60 * 1000) });
    await Class.findByIdAndUpdate(cls._id, { notificationsSent: ["60min"] });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    const result = await runClassReminderTick(now);

    expect(result.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("two concurrent ticks on the same class+window → exactly one send", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await withPushToken(teacher, "tutor-token");

    const now = new Date();
    await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(now.getTime() + 30 * 60 * 1000) });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const [a, b] = await Promise.all([runClassReminderTick(now), runClassReminderTick(now)]);

    expect(a.sent + b.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a cancelled class inside the window is never reminded — status changes suppress it automatically", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await withPushToken(teacher, "tutor-token");

    const now = new Date();
    await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(now.getTime() + 30 * 60 * 1000),
      status: "cancelled",
    });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    const result = await runClassReminderTick(now);

    expect(result.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/classes/:id/status — immediate cancel/postpone notifications", () => {
  function updateStatus(teacher, classId, body) {
    return request(app)
      .patch(`/api/classes/${classId}/status`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send(body);
  }

  test("cancel → 200, status flips, push+email fire immediately to scoped recipients only", async () => {
    const teacher1 = await createTeacher();
    const teacher2 = await createTeacher();
    const stu1 = await createStudent();
    const stu3 = await createStudent(); // enrolled under a different teacher — must never be notified
    await createEnrollment({ student: stu1, tutor: teacher1 });
    await createEnrollment({ student: stu3, tutor: teacher2 });
    await withPushToken(teacher1, "tutor-token");
    await withPushToken(stu1, "stu1-token");
    await withPushToken(stu3, "stu3-token");

    const cls = await createClass({ tutor: teacher1, students: [stu1], scheduledAt: new Date(Date.now() + 3600 * 1000) });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const res = await updateStatus(teacher1, cls._id, { status: "cancelled" });

    expect(res.status).toBe(200);
    expect(res.body.class.status).toBe("cancelled");

    const pushedTokens = JSON.parse(fetchMock.mock.calls[0][1].body).map((m) => m.to);
    expect(pushedTokens.sort()).toEqual(["stu1-token", "tutor-token"]);
    expect(pushedTokens).not.toContain("stu3-token");

    const emailedTo = sendTransactionalEmail.mock.calls.map((c) => c[0].to);
    expect(emailedTo).not.toContain(stu3.email);
  });

  test("postpone with a new scheduledAt → email/push copy includes the new time, class.scheduledAt updates", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await withPushToken(teacher, "tutor-token");

    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(Date.now() + 3600 * 1000) });
    const newTime = new Date(Date.now() + 3 * 24 * 3600 * 1000);

    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const res = await updateStatus(teacher, cls._id, { status: "postponed", scheduledAt: newTime.toISOString() });

    expect(res.status).toBe(200);
    expect(res.body.class.status).toBe("postponed");
    expect(new Date(res.body.class.scheduledAt).getTime()).toBe(newTime.getTime());

    const emailBody = sendTransactionalEmail.mock.calls[0][0].htmlContent;
    expect(emailBody).not.toMatch(/to be confirmed/);
  });

  test("postpone without a new scheduledAt → copy says 'to be confirmed'", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(Date.now() + 3600 * 1000) });
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const res = await updateStatus(teacher, cls._id, { status: "postponed" });

    expect(res.status).toBe(200);
    const emailBody = sendTransactionalEmail.mock.calls[0][0].htmlContent;
    expect(emailBody).toMatch(/to be confirmed/);
  });

  test("a teacher who doesn't own the class → 403, nothing sent", async () => {
    const owner = await createTeacher();
    const other = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: owner });
    const cls = await createClass({ tutor: owner, students: [student], scheduledAt: new Date(Date.now() + 3600 * 1000) });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    const res = await updateStatus(other, cls._id, { status: "cancelled" });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("invalid status → 400", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(Date.now() + 3600 * 1000) });

    const res = await updateStatus(teacher, cls._id, { status: "deleted" });
    expect(res.status).toBe(400);
  });

  test("a class that's already completed → 409, status unchanged", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(Date.now() - 3600 * 1000),
      attendance: [{ studentId: student._id.toString(), status: "present" }],
    });

    const res = await updateStatus(teacher, cls._id, { status: "cancelled" });
    expect(res.status).toBe(409);
    expect((await Class.findById(cls._id)).status).toBe("completed");
  });
});

describe("PATCH /api/classes/:id/status — Google Calendar sync (Phase 19)", () => {
  function updateStatus(teacher, classId, body) {
    return request(app)
      .patch(`/api/classes/${classId}/status`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send(body);
  }

  test("cancel → the Calendar event is deleted, meetingLink/eventId cleared on the class", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(Date.now() + 3600 * 1000),
      meetingLink: "https://meet.google.com/abc-defg-hij",
      googleCalendarEventId: "cal-event-1",
    });
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const res = await updateStatus(teacher, cls._id, { status: "cancelled" });

    expect(res.status).toBe(200);
    expect(deleteMeetEvent).toHaveBeenCalledWith("cal-event-1");
    expect(res.body.class.meetingLink).toBe("");
    expect(res.body.class.googleCalendarEventId).toBeNull();

    const stored = await Class.findById(cls._id);
    expect(stored.meetingLink).toBe("");
    expect(stored.googleCalendarEventId).toBeNull();
  });

  test("cancel, Calendar deletion fails → 502, status/link untouched", async () => {
    deleteMeetEvent.mockRejectedValue(new Error("Google API unreachable"));
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(Date.now() + 3600 * 1000),
      meetingLink: "https://meet.google.com/abc-defg-hij",
      googleCalendarEventId: "cal-event-1",
    });

    const res = await updateStatus(teacher, cls._id, { status: "cancelled" });

    expect(res.status).toBe(502);
    const stored = await Class.findById(cls._id);
    expect(stored.status).toBe("upcoming");
    expect(stored.meetingLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(stored.googleCalendarEventId).toBe("cal-event-1");
  });

  test("postpone with a new scheduledAt → the Calendar event's time is patched, meetingLink/eventId unchanged", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(Date.now() + 3600 * 1000),
      meetingLink: "https://meet.google.com/abc-defg-hij",
      googleCalendarEventId: "cal-event-1",
    });
    const newTime = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const res = await updateStatus(teacher, cls._id, { status: "postponed", scheduledAt: newTime.toISOString() });

    expect(res.status).toBe(200);
    expect(updateMeetEventTime).toHaveBeenCalledWith("cal-event-1", {
      scheduledAt: newTime,
      durationMinutes: cls.durationMinutes,
    });
    expect(deleteMeetEvent).not.toHaveBeenCalled();
    expect(res.body.class.meetingLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(res.body.class.googleCalendarEventId).toBe("cal-event-1");
  });

  test("postpone without a new scheduledAt → no Calendar API call at all", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(Date.now() + 3600 * 1000),
      meetingLink: "https://meet.google.com/abc-defg-hij",
      googleCalendarEventId: "cal-event-1",
    });
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const res = await updateStatus(teacher, cls._id, { status: "postponed" });

    expect(res.status).toBe(200);
    expect(updateMeetEventTime).not.toHaveBeenCalled();
    expect(deleteMeetEvent).not.toHaveBeenCalled();
  });

  test("a class with no Calendar event (manually-linked via the CLI's --link) → cancel succeeds with no Calendar API call", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(Date.now() + 3600 * 1000),
      meetingLink: "https://zoom.us/j/manual-link",
      googleCalendarEventId: null,
    });
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const res = await updateStatus(teacher, cls._id, { status: "cancelled" });

    expect(res.status).toBe(200);
    expect(deleteMeetEvent).not.toHaveBeenCalled();
  });
});
