// Per-user timezone: the app sends the device IANA zone up on login / push-
// token registration, and the backend renders class-time + due-date text in
// each recipient's own zone. The cron *trigger* stays a pure UTC comparison
// — a "starts in 30 min" push fires at the same absolute moment no matter
// where either party is. (Req 5, per-user monthly-relogin anchoring, is
// deliberately out of scope — loginMonth stays global.)
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import {
  createStudent,
  createTeacher,
  createEnrollment,
  createClass,
  createAssignmentDoc,
  signToken,
} from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { sendTransactionalEmail } = await import("../src/services/brevoService.js");
const { runClassReminderTick } = await import("../src/jobs/classReminders.js");
const { notifyAssignmentAssigned } = await import("../src/services/assignmentNotifications.js");
const { formatDateTimeInZone, formatDateInZone } = await import("../src/utils/timezone.js");

beforeAll(connectTestDB);
afterEach(() => {
  jest.restoreAllMocks();
  sendTransactionalEmail.mockClear();
  return clearTestDB();
});
afterAll(disconnectTestDB);

function mockPush() {
  return jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ data: [] }) });
}
function pushMessages(fetchMock) {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe("capturing timezone on the auth / notification touchpoints", () => {
  async function sendOtp(phone) {
    return request(app).post("/api/auth/send-otp").set("X-Forwarded-For", `9.9.9.${Math.floor(Math.random() * 250) + 1}`).send({ phone });
  }
  async function verify(phone, otp, extra = {}) {
    return request(app).post("/api/auth/verify-otp").set("X-Forwarded-For", `9.9.9.${Math.floor(Math.random() * 250) + 1}`).send({ phone, otp, ...extra });
  }

  test("verify-otp stores a valid IANA zone and echoes it back", async () => {
    const student = await createStudent();
    const otp = (await sendOtp(student.phone)).body.devOtp;

    const res = await verify(student.phone, otp, { timezone: "America/New_York" });

    expect(res.status).toBe(200);
    expect(res.body.user.timezone).toBe("America/New_York");
    expect((await User.findById(student._id)).timezone).toBe("America/New_York");
  });

  test("verify-otp ignores a bogus zone — the user keeps the default", async () => {
    const student = await createStudent();
    const otp = (await sendOtp(student.phone)).body.devOtp;

    const res = await verify(student.phone, otp, { timezone: "Not/ARealZone" });

    expect(res.status).toBe(200);
    expect(res.body.user.timezone).toBe("Asia/Kolkata");
    expect((await User.findById(student._id)).timezone).toBe("Asia/Kolkata");
  });

  test("verify-otp with no timezone at all → default is untouched", async () => {
    const student = await createStudent();
    const otp = (await sendOtp(student.phone)).body.devOtp;

    const res = await verify(student.phone, otp);
    expect(res.body.user.timezone).toBe("Asia/Kolkata");
  });

  test("PATCH /api/profile updates the timezone", async () => {
    const student = await createStudent({ timezone: "Asia/Kolkata" });
    const res = await request(app)
      .patch("/api/profile")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ timezone: "Europe/London" });

    expect(res.status).toBe(200);
    expect(res.body.user.timezone).toBe("Europe/London");
  });

  test("POST /api/notifications/register-token carries the timezone through", async () => {
    const student = await createStudent();
    await request(app)
      .post("/api/notifications/register-token")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ pushToken: "ExponentPushToken[x]", timezone: "America/Los_Angeles" });

    expect((await User.findById(student._id)).timezone).toBe("America/Los_Angeles");
  });
});

describe("notification text is rendered per recipient timezone", () => {
  test("a class from an IST tutor to a New_York student: each 'starting soon' push + email shows their own local time", async () => {
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 60 * 60 * 1000);

    const tutor = await createTeacher({ timezone: "Asia/Kolkata" });
    const student = await createStudent({ timezone: "America/New_York" });
    await createEnrollment({ student, tutor });
    await User.findByIdAndUpdate(tutor._id, { pushToken: "tutor-token", email: "tutor@example.com" });
    await User.findByIdAndUpdate(student._id, { pushToken: "student-token", email: "student@example.com" });
    await createClass({ tutor, students: [student], scheduledAt, subject: "Hindi" });

    const fetchMock = mockPush();
    const result = await runClassReminderTick(now);
    expect(result.sent).toBe(1);

    const istLabel = formatDateTimeInZone(scheduledAt, "Asia/Kolkata");
    const nyLabel = formatDateTimeInZone(scheduledAt, "America/New_York");
    expect(istLabel).not.toBe(nyLabel); // sanity: the two zones really do differ here

    const msgs = pushMessages(fetchMock);
    const tutorMsg = msgs.find((m) => m.to === "tutor-token");
    const studentMsg = msgs.find((m) => m.to === "student-token");
    expect(tutorMsg.body).toBe(`Hindi starts at ${istLabel}.`);
    expect(studentMsg.body).toBe(`Hindi starts at ${nyLabel}.`);

    const tutorEmail = sendTransactionalEmail.mock.calls.find((c) => c[0].to === "tutor@example.com")[0];
    const studentEmail = sendTransactionalEmail.mock.calls.find((c) => c[0].to === "student@example.com")[0];
    expect(tutorEmail.htmlContent).toContain(istLabel);
    expect(studentEmail.htmlContent).toContain(nyLabel);
    expect(studentEmail.htmlContent).not.toContain(istLabel);
  });

  test("a recipient with no stored timezone falls back to Asia/Kolkata, doesn't crash", async () => {
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 30 * 60 * 1000);

    const tutor = await createTeacher();
    const student = await createStudent();
    // Force the field genuinely absent, like a pre-migration account.
    await User.updateOne({ _id: student._id }, { $unset: { timezone: 1 } });
    await createEnrollment({ student, tutor });
    await User.findByIdAndUpdate(student._id, { pushToken: "student-token" });
    await createClass({ tutor, students: [student], scheduledAt, subject: "Kannada" });

    const fetchMock = mockPush();
    const result = await runClassReminderTick(now);

    expect(result.sent).toBe(1);
    const msg = pushMessages(fetchMock).find((m) => m.to === "student-token");
    expect(msg.body).toBe(`Kannada starts at ${formatDateTimeInZone(scheduledAt, "Asia/Kolkata")}.`);
  });

  test("assignment due-date text uses the student's timezone", async () => {
    const tutor = await createTeacher();
    const student = await createStudent({ timezone: "America/New_York" });
    await createEnrollment({ student, tutor });
    await User.findByIdAndUpdate(student._id, { email: "s@example.com" });
    // Late-evening UTC → still 'yesterday' in New York, so the date string differs by zone.
    const dueDate = new Date("2026-08-16T02:00:00.000Z");
    const assignment = await createAssignmentDoc({ student, tutor, title: "Essay" });
    assignment.dueDate = dueDate;
    await assignment.save();

    mockPush();
    await notifyAssignmentAssigned(assignment);

    const email = sendTransactionalEmail.mock.calls.find((c) => c[0].to === "s@example.com")[0];
    expect(email.htmlContent).toContain(formatDateInZone(dueDate, "America/New_York"));
    expect(formatDateInZone(dueDate, "America/New_York")).not.toBe(formatDateInZone(dueDate, "Asia/Kolkata"));
  });
});

describe("cron trigger is UTC-only — stored timezones never shift when it fires", () => {
  test("a class 60 min out fires the reminder regardless of tutor/student zones", async () => {
    const now = new Date();
    const tutor = await createTeacher({ timezone: "Pacific/Kiritimati" }); // UTC+14
    const student = await createStudent({ timezone: "Pacific/Pago_Pago" }); // UTC-11
    await createEnrollment({ student, tutor });
    await User.findByIdAndUpdate(student._id, { pushToken: "student-token" });
    await createClass({ tutor, students: [student], scheduledAt: new Date(now.getTime() + 60 * 60 * 1000) });

    mockPush();
    const result = await runClassReminderTick(now);
    expect(result.sent).toBe(1);
  });

  test("a class 3 hours out does NOT fire, even though it's 'tomorrow' in some zones already", async () => {
    const now = new Date();
    const tutor = await createTeacher({ timezone: "Pacific/Kiritimati" });
    const student = await createStudent({ timezone: "Pacific/Kiritimati" });
    await createEnrollment({ student, tutor });
    await User.findByIdAndUpdate(student._id, { pushToken: "student-token" });
    await createClass({ tutor, students: [student], scheduledAt: new Date(now.getTime() + 3 * 60 * 60 * 1000) });

    const fetchMock = mockPush();
    const result = await runClassReminderTick(now);
    expect(result.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
