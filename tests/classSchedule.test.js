// Teacher-initiated scheduling (app-flow counterpart to
// scripts/scheduleClass.js) — see classController.createClass.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/googleCalendarService.js", () => ({
  createMeetEvent: jest.fn(),
  updateMeetEventTime: jest.fn(),
  deleteMeetEvent: jest.fn(),
}));

const { default: app } = await import("../src/app.js");
const { default: Class } = await import("../src/models/Class.js");
const { createMeetEvent } = await import("../src/services/googleCalendarService.js");

beforeAll(connectTestDB);
afterEach(() => {
  createMeetEvent.mockReset();
  return clearTestDB();
});
afterAll(disconnectTestDB);

const VALID_BODY = { subject: "Hindi Conversation", scheduledAt: "2026-09-01T18:00:00.000Z" };

test("teacher schedules a class for their own assigned student → 200, matches script's defaults, Meet link + eventId persisted", async () => {
  createMeetEvent.mockResolvedValue({ meetingLink: "https://meet.google.com/abc-defg-hij", eventId: "cal-event-1" });

  const teacher = await createTeacher();
  const student = await createStudent();
  await createEnrollment({ student, tutor: teacher });

  const res = await request(app)
    .post("/api/classes")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ ...VALID_BODY, studentId: student._id.toString() });

  expect(res.status).toBe(200);
  expect(res.body.class.subject).toBe("Hindi Conversation");
  expect(res.body.class.tutor).toBe(teacher._id.toString());
  expect(res.body.class.students).toEqual([student._id.toString()]);
  expect(res.body.class.batchType).toBe("1-on-1");
  expect(res.body.class.durationMinutes).toBe(45);
  expect(res.body.class.meetingLink).toBe("https://meet.google.com/abc-defg-hij");
  expect(res.body.class.googleCalendarEventId).toBe("cal-event-1");
  expect(res.body.class.status).toBe("upcoming");

  expect(createMeetEvent).toHaveBeenCalledWith({
    subject: "Hindi Conversation",
    scheduledAt: new Date(VALID_BODY.scheduledAt),
    durationMinutes: 45,
  });

  const stored = await Class.findById(res.body.class._id);
  expect(stored.meetingLink).toBe("https://meet.google.com/abc-defg-hij");
  expect(stored.googleCalendarEventId).toBe("cal-event-1");
});

test("Google Calendar API failure → 502, clear error, no class document created", async () => {
  createMeetEvent.mockRejectedValue(new Error("Google API unreachable"));

  const teacher = await createTeacher();
  const student = await createStudent();
  await createEnrollment({ student, tutor: teacher });

  const res = await request(app)
    .post("/api/classes")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ ...VALID_BODY, studentId: student._id.toString() });

  expect(res.status).toBe(502);
  expect(res.body.success).toBe(false);
  expect(res.body.message).toBeTruthy();
  expect(await Class.countDocuments()).toBe(0);
});

test("teacher scheduling for a student not assigned to them → 403, no class created", async () => {
  const teacher = await createTeacher();
  const otherTeacher = await createTeacher();
  const student = await createStudent();
  await createEnrollment({ student, tutor: otherTeacher });

  const res = await request(app)
    .post("/api/classes")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ ...VALID_BODY, studentId: student._id.toString() });

  expect(res.status).toBe(403);
  expect(res.body.message).toBe("This student isn't assigned to you.");
});

test("student role (non-teacher) → 403", async () => {
  const student = await createStudent();

  const res = await request(app)
    .post("/api/classes")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .send({ ...VALID_BODY, studentId: student._id.toString() });

  expect(res.status).toBe(403);
});

test("missing required fields → 400", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  await createEnrollment({ student, tutor: teacher });

  const res = await request(app)
    .post("/api/classes")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ studentId: student._id.toString() });

  expect(res.status).toBe(400);
  expect(res.body.message).toBe("studentId, subject, and scheduledAt are required.");
});

test("invalid scheduledAt date → 400", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  await createEnrollment({ student, tutor: teacher });

  const res = await request(app)
    .post("/api/classes")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ studentId: student._id.toString(), subject: "Hindi Conversation", scheduledAt: "not-a-date" });

  expect(res.status).toBe(400);
  expect(res.body.message).toBe("Invalid scheduledAt date.");
});
