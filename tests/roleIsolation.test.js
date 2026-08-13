// Highest priority per ROADMAP.md Phase 12: this is the logic that protects
// student data. Covers both isolation layers confirmed working manually in
// Phase 16 — the blanket requireRole("teacher") gate, and the
// Enrollment-ownership check inside createAssignment that stops one teacher
// from touching another teacher's student.
import { jest } from "@jest/globals";
import request from "supertest";
import jwt from "jsonwebtoken";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));
jest.unstable_mockModule("../src/config/cloudinary.js", () => ({
  uploadBuffer: jest.fn().mockResolvedValue({ secure_url: "https://res.cloudinary.com/fake/mock.jpg" }),
}));

const { default: app } = await import("../src/app.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

describe("teacher-only routes reject students", () => {
  test("GET /api/roster — student token → 403", async () => {
    const student = await createStudent();
    const res = await request(app).get("/api/roster").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(403);
  });

  test("POST /api/assignments — student token → 403", async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const res = await request(app)
      .post("/api/assignments")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ studentId: student._id.toString(), type: "homework", title: "Chapter 3" });
    expect(res.status).toBe(403);
    // The generic role message — not the ownership-specific one below.
    expect(res.body.message).toBe("Not authorized.");
  });

  test("PATCH /api/assignments/:id/review — student token → 403", async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const res = await request(app)
      .patch(`/api/assignments/${teacher._id}/review`)
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ score: "9/10" });
    expect(res.status).toBe(403);
  });
});

describe("cross-teacher ownership isolation", () => {
  test("Teacher A assigning work to Teacher B's student → 403 with ownership message, not the generic role message", async () => {
    const teacherA = await createTeacher();
    const teacherB = await createTeacher();
    const studentOfB = await createStudent();
    await createEnrollment({ student: studentOfB, tutor: teacherB });

    const res = await request(app)
      .post("/api/assignments")
      .set("Authorization", `Bearer ${signToken(teacherA)}`)
      .send({ studentId: studentOfB._id.toString(), type: "homework", title: "Chapter 3" });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("This student isn't assigned to you.");
    expect(res.body.message).not.toBe("Not authorized.");
  });

  test("Teacher assigning work to their own enrolled student → succeeds (control case)", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app)
      .post("/api/assignments")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ studentId: student._id.toString(), type: "homework", title: "Chapter 3" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("no token / bad token", () => {
  test("GET /api/classes — no Authorization header → 401", async () => {
    const res = await request(app).get("/api/classes");
    expect(res.status).toBe(401);
  });

  test("GET /api/roster — no Authorization header → 401", async () => {
    const res = await request(app).get("/api/roster");
    expect(res.status).toBe(401);
  });

  test("Malformed JWT (garbage string) → 401", async () => {
    const res = await request(app).get("/api/classes").set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
  });

  test("JWT signed with the wrong secret → 401", async () => {
    const student = await createStudent();
    const badToken = jwt.sign(
      { sub: student._id.toString(), phone: student.phone, role: student.role },
      "wrong-secret",
      { expiresIn: "30d" }
    );
    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${badToken}`);
    expect(res.status).toBe(401);
  });

  test("Expired JWT → 401", async () => {
    const student = await createStudent();
    const expiredToken = signToken(student, { expiresIn: "-1s" });
    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });
});
