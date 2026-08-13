// Admin web dashboard (ROADMAP.md Phase 17): password login for isAdmin
// accounts, plus the two read-only aggregation endpoints. The
// cross-contamination tests are the priority per the phase brief — proving
// the admin (password, role: "admin") and app (OTP, role: "student"|
// "teacher") token shapes can never be used as each other.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import {
  createStudent,
  createTeacher,
  createEnrollment,
  createClass,
  createAssignmentDoc,
  createAdminUser,
  signToken,
  signAdminToken,
  nextIp,
} from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function adminLogin(body) {
  return request(app).post("/api/admin/login").set("X-Forwarded-For", nextIp()).send(body);
}

describe("POST /api/admin/login", () => {
  test("correct credentials + isAdmin: true → 200 with a token", async () => {
    const { user, plainPassword } = await createAdminUser();
    const res = await adminLogin({ email: user.email, password: plainPassword });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.email).toBe(user.email);
  });

  test("correct password but isAdmin: false → 403", async () => {
    const { user, plainPassword } = await createAdminUser({ isAdmin: false });
    const res = await adminLogin({ email: user.email, password: plainPassword });
    expect(res.status).toBe(403);
  });

  test("wrong password → 401", async () => {
    const { user } = await createAdminUser();
    const res = await adminLogin({ email: user.email, password: "definitely-wrong" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Incorrect email or password.");
  });

  test("unknown email → 401 with the same message as wrong password (doesn't leak which case it was)", async () => {
    const res = await adminLogin({ email: "nobody@example.com", password: "whatever12345" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Incorrect email or password.");
  });
});

describe("GET /api/admin/teachers", () => {
  test("no token → 401", async () => {
    const res = await request(app).get("/api/admin/teachers");
    expect(res.status).toBe(401);
  });

  test("non-admin teacher token → 403", async () => {
    const teacher = await createTeacher();
    const res = await request(app).get("/api/admin/teachers").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(403);
  });

  test("non-admin student token → 403", async () => {
    const student = await createStudent();
    const res = await request(app).get("/api/admin/teachers").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(403);
  });

  test("admin token → 200 with correct aggregated shape", async () => {
    const { user: admin } = await createAdminUser();
    const teacher = await createTeacher({ name: "Sudi" });
    const s1 = await createStudent();
    const s2 = await createStudent();
    await createEnrollment({ student: s1, tutor: teacher });
    await createEnrollment({ student: s2, tutor: teacher });
    await createClass({ tutor: teacher, students: [s1], scheduledAt: new Date(), status: "completed" });
    await createClass({ tutor: teacher, students: [s1], scheduledAt: new Date() }); // still upcoming

    const res = await request(app).get("/api/admin/teachers").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    expect(res.status).toBe(200);
    const row = res.body.teachers.find((t) => t.name === "Sudi");
    expect(row).toMatchObject({ assignedStudentCount: 2, classesScheduled: 2, classesCompleted: 1 });
  });
});

describe("GET /api/admin/students", () => {
  test("no token → 401", async () => {
    const res = await request(app).get("/api/admin/students");
    expect(res.status).toBe(401);
  });

  test("non-admin teacher token → 403", async () => {
    const teacher = await createTeacher();
    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(403);
  });

  test("admin token → 200 with correct aggregated shape", async () => {
    const { user: admin } = await createAdminUser();
    const teacher = await createTeacher();
    const student = await createStudent({
      name: "Priya",
      completedClassCount: 10,
      isTrial: true,
      accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await createAssignmentDoc({ student, tutor: teacher, type: "homework", title: "HW1" });
    const hw2 = await createAssignmentDoc({ student, tutor: teacher, type: "homework", title: "HW2" });
    hw2.status = "submitted";
    await hw2.save();
    await createAssignmentDoc({ student, tutor: teacher, type: "assessment", title: "A1" });

    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    expect(res.status).toBe(200);
    const row = res.body.students.find((s) => s.name === "Priya");
    expect(row.completedClassCount).toBe(10);
    expect(row.assessmentsUnlocked).toBe(true);
    expect(row.homework).toEqual({ assigned: 2, submitted: 1 });
    expect(row.assessments).toEqual({ assigned: 1, submitted: 0 });
    expect(row.isTrial).toBe(true);
    expect(row.accessExpiresAt).toBeTruthy();
  });

  test("a legacy record missing completedClassCount/isTrial entirely (pre-dates those fields) shows 0/false, not an omitted key", async () => {
    const { user: admin } = await createAdminUser();
    // Bypasses Mongoose (and its schema defaults) via the raw driver to
    // simulate a real pre-Phase-13/14 document that never had these fields
    // written at all — User.create() would apply the schema defaults and
    // mask exactly the bug this test caught during manual verification.
    const { insertedId } = await User.collection.insertOne({
      phone: "9800000099",
      name: "Legacy Student",
      role: "student",
    });

    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    const row = res.body.students.find((s) => s._id === insertedId.toString());
    expect(row.completedClassCount).toBe(0);
    expect(row.assessmentsUnlocked).toBe(false);
    expect(row.isTrial).toBe(false);
  });

  test("non-trial student's accessExpiresAt is always null in the response", async () => {
    const { user: admin } = await createAdminUser();
    await createStudent({ name: "NonTrial", isTrial: false });

    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    const row = res.body.students.find((s) => s.name === "NonTrial");
    expect(row.accessExpiresAt).toBeNull();
  });
});

describe("GET /api/feedback is reachable from the admin dashboard with no changes needed", () => {
  test("admin (password-token) → 200", async () => {
    const { user: admin } = await createAdminUser();
    const res = await request(app).get("/api/feedback").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.feedback)).toBe(true);
  });
});

describe("cross-contamination: an admin's password token can never be used as an app session", () => {
  test("→ requireRole('teacher') route (/api/roster) → 403", async () => {
    const { user: admin } = await createAdminUser();
    const res = await request(app).get("/api/roster").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    expect(res.status).toBe(403);
  });

  test("→ requireRole('teacher') route (POST /api/assignments) → 403", async () => {
    const { user: admin } = await createAdminUser();
    const res = await request(app)
      .post("/api/assignments")
      .set("Authorization", `Bearer ${signAdminToken(admin)}`)
      .send({ studentId: admin._id.toString(), type: "homework", title: "x" });
    expect(res.status).toBe(403);
  });
});

describe("cross-contamination: a student/teacher's OTP token can never be used as an admin session", () => {
  test("non-admin teacher's OTP token → requireAdmin route (/api/admin/teachers) → 403", async () => {
    const teacher = await createTeacher();
    const res = await request(app).get("/api/admin/teachers").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(403);
  });

  test("student's OTP token → requireAdmin route (/api/admin/students) → 403", async () => {
    const student = await createStudent();
    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(403);
  });

  test("no bearer token exchange exists for admin login — it's a fresh email+password check regardless of any Authorization header sent", async () => {
    const teacher = await createTeacher();
    const res = await request(app)
      .post("/api/admin/login")
      .set("X-Forwarded-For", nextIp())
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ email: teacher.email, password: "irrelevant" });
    expect(res.status).toBe(401);
  });
});

describe("legitimate cross-surface access: an OTP-issued token for a genuine isAdmin user still works on admin routes", () => {
  test("isAdmin: true teacher's OTP token → /api/admin/teachers → 200 (identity-based, not surface-based — matches 'reuse User.isAdmin', no second identity system)", async () => {
    const teacher = await createTeacher({ isAdmin: true }); // never ran setAdminPassword.js
    const res = await request(app).get("/api/admin/teachers").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(200);
  });
});
