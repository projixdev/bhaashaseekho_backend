// Teacher-initiated scheduling (app-flow counterpart to
// scripts/scheduleClass.js) — see classController.createClass.
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, signToken } from "./helpers/fixtures.js";

const { default: app } = await import("../src/app.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

const VALID_BODY = { subject: "Hindi Conversation", scheduledAt: "2026-09-01T18:00:00.000Z" };

test("teacher schedules a class for their own assigned student → 200, matches script's defaults", async () => {
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
  expect(res.body.class.meetingLink).toBe("");
  expect(res.body.class.status).toBe("upcoming");
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
