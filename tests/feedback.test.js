// POST/GET /api/feedback (ROADMAP.md Phase 15). Attendance is seeded
// directly via the createClass({ attendance }) fixture rather than the real
// endClass endpoint — that flow is already covered in endClass.test.js, so
// this file focuses on feedback eligibility and the admin gate.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createClass, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: Feedback } = await import("../src/models/Feedback.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function submitFeedback(user, body) {
  return request(app).post("/api/feedback").set("Authorization", `Bearer ${signToken(user)}`).send(body);
}

test("present student submits feedback → 201, correct fields stored", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({
    tutor: teacher,
    students: [student],
    scheduledAt: new Date(),
    attendance: [{ studentId: student._id.toString(), status: "present" }],
  });

  const res = await submitFeedback(student, { classId: cls._id.toString(), sentiment: "agree", comment: "Loved it" });

  expect(res.status).toBe(201);
  expect(res.body.feedback).toMatchObject({
    class: cls._id.toString(),
    student: student._id.toString(),
    tutor: teacher._id.toString(),
    sentiment: "agree",
    comment: "Loved it",
  });

  const stored = await Feedback.findOne({ class: cls._id, student: student._id });
  expect(stored).not.toBeNull();
  expect(stored.sentiment).toBe("agree");
});

test("absent student attempts feedback → 403", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({
    tutor: teacher,
    students: [student],
    scheduledAt: new Date(),
    attendance: [{ studentId: student._id.toString(), status: "absent" }],
  });

  const res = await submitFeedback(student, { classId: cls._id.toString(), sentiment: "agree" });
  expect(res.status).toBe(403);
});

test("partial student attempts feedback → 403", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({
    tutor: teacher,
    students: [student],
    scheduledAt: new Date(),
    attendance: [{ studentId: student._id.toString(), status: "partial" }],
  });

  const res = await submitFeedback(student, { classId: cls._id.toString(), sentiment: "disagree" });
  expect(res.status).toBe(403);
});

test("class not yet ended (no attendance recorded) → 403, not a 500", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date() });

  const res = await submitFeedback(student, { classId: cls._id.toString(), sentiment: "agree" });
  expect(res.status).toBe(403);
});

test("duplicate submission for the same (class, student) → 409, not a raw Mongo error", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({
    tutor: teacher,
    students: [student],
    scheduledAt: new Date(),
    attendance: [{ studentId: student._id.toString(), status: "present" }],
  });

  const first = await submitFeedback(student, { classId: cls._id.toString(), sentiment: "agree" });
  expect(first.status).toBe(201);

  const second = await submitFeedback(student, { classId: cls._id.toString(), sentiment: "disagree" });
  expect(second.status).toBe(409);
  expect(second.body.message).toBe("You've already left feedback for this class.");

  expect(await Feedback.countDocuments({ class: cls._id, student: student._id })).toBe(1);
});

describe("GET /api/feedback/pending", () => {
  test("returns a completed class the student attended (present) with no feedback yet", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      subject: "Kannada",
      scheduledAt: new Date(),
      attendance: [{ studentId: student._id.toString(), status: "present" }],
    });

    const res = await request(app).get("/api/feedback/pending").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(200);
    expect(res.body.classes.map((c) => c._id)).toEqual([cls._id.toString()]);
  });

  test("excludes a class once feedback has been submitted for it", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(),
      attendance: [{ studentId: student._id.toString(), status: "present" }],
    });
    await submitFeedback(student, { classId: cls._id.toString(), sentiment: "agree" });

    const res = await request(app).get("/api/feedback/pending").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.body.classes).toEqual([]);
  });

  test("excludes classes where the student was partial or absent", async () => {
    const teacher = await createTeacher();
    const partialStudent = await createStudent();
    const absentStudent = await createStudent();
    await createClass({
      tutor: teacher,
      students: [partialStudent],
      scheduledAt: new Date(),
      attendance: [{ studentId: partialStudent._id.toString(), status: "partial" }],
    });
    await createClass({
      tutor: teacher,
      students: [absentStudent],
      scheduledAt: new Date(),
      attendance: [{ studentId: absentStudent._id.toString(), status: "absent" }],
    });

    const asPartial = await request(app)
      .get("/api/feedback/pending")
      .set("Authorization", `Bearer ${signToken(partialStudent)}`);
    expect(asPartial.body.classes).toEqual([]);

    const asAbsent = await request(app)
      .get("/api/feedback/pending")
      .set("Authorization", `Bearer ${signToken(absentStudent)}`);
    expect(asAbsent.body.classes).toEqual([]);
  });

  test("never leaks another student's pending class ($elemMatch correctness)", async () => {
    const teacher = await createTeacher();
    const studentA = await createStudent();
    const studentB = await createStudent();
    // studentA present, studentB absent, same class — a query that checks
    // attendance.student and attendance.status as independent conditions
    // (not $elemMatch) would incorrectly match this class for studentB too.
    await createClass({
      tutor: teacher,
      students: [studentA, studentB],
      scheduledAt: new Date(),
      attendance: [
        { studentId: studentA._id.toString(), status: "present" },
        { studentId: studentB._id.toString(), status: "absent" },
      ],
    });

    const asB = await request(app).get("/api/feedback/pending").set("Authorization", `Bearer ${signToken(studentB)}`);
    expect(asB.body.classes).toEqual([]);
  });
});

describe("GET /api/feedback", () => {
  test("non-admin (regular teacher) → 403", async () => {
    const teacher = await createTeacher({ isAdmin: false });
    const res = await request(app).get("/api/feedback").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(403);
  });

  test("non-admin (student) → 403", async () => {
    const student = await createStudent();
    const res = await request(app).get("/api/feedback").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(403);
  });

  test("admin → 200, correct populated shape", async () => {
    const admin = await createTeacher({ isAdmin: true, name: "Founder" });
    const teacher = await createTeacher({ name: "Sudi" });
    const student = await createStudent({ name: "Priya" });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      subject: "Hindi",
      scheduledAt: new Date(),
      attendance: [{ studentId: student._id.toString(), status: "present" }],
    });
    await submitFeedback(student, { classId: cls._id.toString(), sentiment: "agree", comment: "Great class" });

    const res = await request(app).get("/api/feedback").set("Authorization", `Bearer ${signToken(admin)}`);
    expect(res.status).toBe(200);
    expect(res.body.feedback).toHaveLength(1);
    expect(res.body.feedback[0]).toMatchObject({
      sentiment: "agree",
      comment: "Great class",
      student: { name: "Priya" },
      tutor: { name: "Sudi" },
      class: { subject: "Hindi" },
    });
  });
});
