// GET /api/enrollment/me — the student-facing mirror of rosterController's
// teacher view, for the app's Profile screen.
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, signToken } from "./helpers/fixtures.js";

const { default: app } = await import("../src/app.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

test("returns the student's own enrollments with tutor name", async () => {
  const teacher = await createTeacher({ name: "Sudi" });
  const student = await createStudent();
  await createEnrollment({ student, tutor: teacher, courseSlug: "kannada", batchType: "1-on-1" });

  const res = await request(app).get("/api/enrollment/me").set("Authorization", `Bearer ${signToken(student)}`);

  expect(res.status).toBe(200);
  expect(res.body.enrollments).toEqual([
    { courseSlug: "kannada", batchType: "1-on-1", status: "active", tutor: { name: "Sudi" } },
  ]);
});

test("an enrollment with no tutor assigned yet → tutor: null, not an error", async () => {
  const student = await createStudent();
  await createEnrollment({ student, tutor: null, courseSlug: "hindi" });

  const res = await request(app).get("/api/enrollment/me").set("Authorization", `Bearer ${signToken(student)}`);

  expect(res.status).toBe(200);
  expect(res.body.enrollments[0].tutor).toBeNull();
});

test("never returns another student's enrollment", async () => {
  const teacher = await createTeacher();
  const studentA = await createStudent();
  const studentB = await createStudent();
  await createEnrollment({ student: studentA, tutor: teacher, courseSlug: "kannada" });
  await createEnrollment({ student: studentB, tutor: teacher, courseSlug: "telugu" });

  const res = await request(app).get("/api/enrollment/me").set("Authorization", `Bearer ${signToken(studentA)}`);

  expect(res.body.enrollments).toHaveLength(1);
  expect(res.body.enrollments[0].courseSlug).toBe("kannada");
});

test("a teacher (not a student) → empty array, not an error", async () => {
  const teacher = await createTeacher();

  const res = await request(app).get("/api/enrollment/me").set("Authorization", `Bearer ${signToken(teacher)}`);

  expect(res.status).toBe(200);
  expect(res.body.enrollments).toEqual([]);
});

test("no token → 401", async () => {
  const res = await request(app).get("/api/enrollment/me");
  expect(res.status).toBe(401);
});
