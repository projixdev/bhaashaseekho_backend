// PATCH /api/classes/:id/end (ROADMAP.md Phase 13). The idempotency
// guarantee is the priority per the phase brief: ending the same class
// twice — including two truly concurrent requests — must increment
// completedClassCount exactly once per present student, never twice.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createClass, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function endClass(teacher, classId, attendance) {
  return request(app)
    .patch(`/api/classes/${classId}/end`)
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ attendance });
}

test("present increments completedClassCount; partial and absent don't", async () => {
  const teacher = await createTeacher();
  const present = await createStudent();
  const partial = await createStudent();
  const absent = await createStudent();
  const cls = await createClass({ tutor: teacher, students: [present, partial, absent], scheduledAt: new Date() });

  const res = await endClass(teacher, cls._id, [
    { studentId: present._id.toString(), status: "present" },
    { studentId: partial._id.toString(), status: "partial" },
    { studentId: absent._id.toString(), status: "absent" },
  ]);

  expect(res.status).toBe(200);
  expect(res.body.class.status).toBe("completed");

  expect((await User.findById(present._id)).completedClassCount).toBe(1);
  expect((await User.findById(partial._id)).completedClassCount).toBe(0);
  expect((await User.findById(absent._id)).completedClassCount).toBe(0);
});

test("ending the same class twice sequentially → second call 409, no double-increment", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date() });
  const attendance = [{ studentId: student._id.toString(), status: "present" }];

  const first = await endClass(teacher, cls._id, attendance);
  expect(first.status).toBe(200);

  const second = await endClass(teacher, cls._id, attendance);
  expect(second.status).toBe(409);
  expect(second.body.message).toBe("This class has already been ended.");

  expect((await User.findById(student._id)).completedClassCount).toBe(1);
});

test("ending the same class twice CONCURRENTLY → exactly one 200 and one 409, count incremented once", async () => {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date() });
  const attendance = [{ studentId: student._id.toString(), status: "present" }];

  const [a, b] = await Promise.all([endClass(teacher, cls._id, attendance), endClass(teacher, cls._id, attendance)]);

  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([200, 409]);

  expect((await User.findById(student._id)).completedClassCount).toBe(1);
});

test("teacher who doesn't own the class → 403", async () => {
  const owner = await createTeacher();
  const otherTeacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass({ tutor: owner, students: [student], scheduledAt: new Date() });

  const res = await endClass(otherTeacher, cls._id, [{ studentId: student._id.toString(), status: "present" }]);
  expect(res.status).toBe(403);

  expect((await User.findById(student._id)).completedClassCount).toBe(0);
});

test("attendance missing an enrolled student → 400", async () => {
  const teacher = await createTeacher();
  const studentA = await createStudent();
  const studentB = await createStudent();
  const cls = await createClass({ tutor: teacher, students: [studentA, studentB], scheduledAt: new Date() });

  const res = await endClass(teacher, cls._id, [{ studentId: studentA._id.toString(), status: "present" }]);
  expect(res.status).toBe(400);

  const reloaded = await request(app)
    .get("/api/classes")
    .set("Authorization", `Bearer ${signToken(teacher)}`);
  expect(reloaded.body.classes.find((c) => c._id === cls._id.toString()).status).toBe("upcoming");
});

test("attendance includes a student not enrolled in this class → 400", async () => {
  const teacher = await createTeacher();
  const enrolled = await createStudent();
  const outsider = await createStudent();
  const cls = await createClass({ tutor: teacher, students: [enrolled], scheduledAt: new Date() });

  const res = await endClass(teacher, cls._id, [
    { studentId: enrolled._id.toString(), status: "present" },
    { studentId: outsider._id.toString(), status: "present" },
  ]);
  expect(res.status).toBe(400);
  expect((await User.findById(outsider._id)).completedClassCount).toBe(0);
});
