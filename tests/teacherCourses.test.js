// GET/POST /api/teacher-courses — a teacher's own "I can teach this"
// requests against the fixed 12-combination course taxonomy (Phase 22
// course discovery). Approve/reject live on the admin side instead
// (tests/adminCrud.test.js), since only admin can act on them.
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, signToken } from "./helpers/fixtures.js";

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

describe("POST /api/teacher-courses", () => {
  test("requesting a valid, new course → 200, added as pending", async () => {
    const teacher = await createTeacher();

    const res = await request(app)
      .post("/api/teacher-courses")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ courseSlug: "kannada-speaking" });

    expect(res.status).toBe(200);
    expect(res.body.teachableCourses).toEqual([{ courseSlug: "kannada-speaking", status: "pending" }]);
    const stored = await User.findById(teacher._id).lean();
    expect(stored.teachableCourses).toEqual([{ courseSlug: "kannada-speaking", status: "pending" }]);
  });

  test("requesting the same course twice → idempotent, no duplicate entry", async () => {
    const teacher = await createTeacher();
    const token = signToken(teacher);

    await request(app).post("/api/teacher-courses").set("Authorization", `Bearer ${token}`).send({ courseSlug: "hindi-academics" });
    await request(app).post("/api/teacher-courses").set("Authorization", `Bearer ${token}`).send({ courseSlug: "hindi-academics" });

    const stored = await User.findById(teacher._id);
    expect(stored.teachableCourses).toHaveLength(1);
  });

  test("re-requesting an already-approved course leaves it approved, not reset to pending", async () => {
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, {
      teachableCourses: [{ courseSlug: "telugu-academics", status: "approved" }],
    });

    const res = await request(app)
      .post("/api/teacher-courses")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ courseSlug: "telugu-academics" });

    expect(res.status).toBe(200);
    expect(res.body.teachableCourses).toEqual([{ courseSlug: "telugu-academics", status: "approved" }]);
  });

  test("unknown courseSlug → 400, nothing saved", async () => {
    const teacher = await createTeacher();

    const res = await request(app)
      .post("/api/teacher-courses")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ courseSlug: "klingon-101" });

    expect(res.status).toBe(400);
    const stored = await User.findById(teacher._id);
    expect(stored.teachableCourses).toEqual([]);
  });

  test("a student → 403", async () => {
    const student = await createStudent();

    const res = await request(app)
      .post("/api/teacher-courses")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ courseSlug: "kannada-speaking" });

    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const res = await request(app).post("/api/teacher-courses").send({ courseSlug: "kannada-speaking" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/teacher-courses/me", () => {
  test("returns this teacher's own list, not another teacher's", async () => {
    const teacherA = await createTeacher();
    const teacherB = await createTeacher();
    await User.findByIdAndUpdate(teacherA._id, { teachableCourses: [{ courseSlug: "kannada-speaking", status: "pending" }] });
    await User.findByIdAndUpdate(teacherB._id, { teachableCourses: [{ courseSlug: "hindi-academics", status: "approved" }] });

    const res = await request(app).get("/api/teacher-courses/me").set("Authorization", `Bearer ${signToken(teacherA)}`);

    expect(res.status).toBe(200);
    expect(res.body.teachableCourses).toEqual([{ courseSlug: "kannada-speaking", status: "pending" }]);
  });

  test("no requests yet → empty array, not an error", async () => {
    const teacher = await createTeacher();

    const res = await request(app).get("/api/teacher-courses/me").set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(200);
    expect(res.body.teachableCourses).toEqual([]);
  });

  test("a student → 403", async () => {
    const student = await createStudent();
    const res = await request(app).get("/api/teacher-courses/me").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(403);
  });
});
