// Teacher/Student CRUD on the admin dashboard (extends ROADMAP.md Phase 17
// beyond the read-only aggregations + Add Teacher already covered by
// adminDashboard.test.js). Every route here sits behind requireAuth +
// requireAdmin, already proven exhaustively for GET /api/admin/teachers and
// POST /api/admin/teachers in that file — this file focuses on what's new:
// single-detail GET, PATCH, soft-delete DELETE, and POST /api/admin/students.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import {
  createStudent,
  createTeacher,
  createEnrollment,
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

async function adminToken() {
  const { user } = await createAdminUser();
  return signAdminToken(user);
}

describe("GET /api/admin/teachers/:id", () => {
  test("admin token → 200 with the same aggregated shape as the list row", async () => {
    const token = await adminToken();
    const teacher = await createTeacher({ name: "Sudi" });
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app).get(`/api/admin/teachers/${teacher._id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.teacher).toMatchObject({
      _id: teacher._id.toString(),
      name: "Sudi",
      assignedStudentCount: 1,
      isActive: true,
    });
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const res = await request(app).get(`/api/admin/teachers/${student._id}`).set("Authorization", `Bearer ${token}`); // wrong role
    expect(res.status).toBe(404);
  });

  test("no token → 401", async () => {
    const teacher = await createTeacher();
    const res = await request(app).get(`/api/admin/teachers/${teacher._id}`);
    expect(res.status).toBe(401);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    const res = await request(app).get(`/api/admin/teachers/${teacher._id}`).set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/admin/teachers/:id", () => {
  function patchTeacher(id, body, token) {
    return request(app).patch(`/api/admin/teachers/${id}`).set("Authorization", `Bearer ${token}`).send(body);
  }

  test("valid edit of name/email/phone → 200, persisted", async () => {
    const token = await adminToken();
    const teacher = await createTeacher({ name: "Old Name", phone: "9800000301" });

    const res = await patchTeacher(teacher._id, { name: "New Name", phone: "9800000302", email: "newmail@example.com" }, token);
    expect(res.status).toBe(200);
    expect(res.body.teacher).toMatchObject({ name: "New Name", phone: "9800000302", email: "newmail@example.com" });

    const stored = await User.findById(teacher._id);
    expect(stored.name).toBe("New Name");
    expect(stored.phone).toBe("9800000302");
    expect(stored.email).toBe("newmail@example.com");
  });

  test("email: \"\" clears a teacher's email", async () => {
    const token = await adminToken();
    const teacher = await createTeacher({ email: "has-one@example.com" });

    const res = await patchTeacher(teacher._id, { email: "" }, token);
    expect(res.status).toBe(200);
    expect(res.body.teacher.email).toBeNull();

    const stored = await User.findById(teacher._id);
    expect(stored.email).toBeUndefined();
  });

  test("duplicate email (another account's) → 409, original untouched", async () => {
    const token = await adminToken();
    await createTeacher({ email: "taken@example.com" });
    const teacher = await createTeacher({ name: "Mine", email: "mine@example.com" });

    const res = await patchTeacher(teacher._id, { email: "taken@example.com" }, token);
    expect(res.status).toBe(409);
    expect((await User.findById(teacher._id)).email).toBe("mine@example.com");
  });

  test("duplicate phone (another account's) → 409", async () => {
    const token = await adminToken();
    await createTeacher({ phone: "9800000303" });
    const teacher = await createTeacher();

    const res = await patchTeacher(teacher._id, { phone: "9800000303" }, token);
    expect(res.status).toBe(409);
  });

  test("blank name → 400", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const res = await patchTeacher(teacher._id, { name: "   " }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.name).toBeTruthy();
  });

  test("invalid email format → 400", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const res = await patchTeacher(teacher._id, { email: "not-an-email" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeTruthy();
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const res = await patchTeacher(student._id, { name: "X" }, token); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    const res = await patchTeacher(teacher._id, { name: "X" }, signToken(teacher));
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const teacher = await createTeacher();
    const res = await request(app).patch(`/api/admin/teachers/${teacher._id}`).send({ name: "X" });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/admin/teachers/:id", () => {
  function deleteTeacher(id, token, query = "") {
    return request(app).delete(`/api/admin/teachers/${id}${query}`).set("Authorization", `Bearer ${token}`);
  }

  test("no active enrollments → 200, soft-deleted (isActive: false, doc still exists)", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();

    const res = await deleteTeacher(teacher._id, token);
    expect(res.status).toBe(200);
    expect(res.body.teacher.isActive).toBe(false);

    const stored = await User.findById(teacher._id);
    expect(stored).not.toBeNull();
    expect(stored.isActive).toBe(false);
  });

  test("has an active enrollment → 409, not deactivated", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await deleteTeacher(teacher._id, token);
    expect(res.status).toBe(409);
    expect((await User.findById(teacher._id)).isActive).not.toBe(false);
  });

  test("has an active enrollment but ?force=true → 200, deactivated anyway", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await deleteTeacher(teacher._id, token, "?force=true");
    expect(res.status).toBe(200);
    expect((await User.findById(teacher._id)).isActive).toBe(false);
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const res = await deleteTeacher(student._id, token); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    const res = await deleteTeacher(teacher._id, signToken(teacher));
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const teacher = await createTeacher();
    const res = await request(app).delete(`/api/admin/teachers/${teacher._id}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/students", () => {
  function createStudentReq(body, token) {
    return request(app).post("/api/admin/students").set("Authorization", `Bearer ${token}`).send(body);
  }

  test("valid creation → 201", async () => {
    const token = await adminToken();
    const res = await createStudentReq({ name: "New Student", phone: "9800000401", email: "newstudent@example.com" }, token);

    expect(res.status).toBe(201);
    expect(res.body.student).toMatchObject({ name: "New Student", phone: "9800000401", email: "newstudent@example.com" });

    const stored = await User.findOne({ phone: "9800000401" }).select("+password");
    expect(stored.role).toBe("student");
    expect(stored.isAdmin).toBe(false);
    expect(stored.password).toBeUndefined();
  });

  test("a freshly admin-created student can immediately log in via the existing OTP flow", async () => {
    const token = await adminToken();
    const created = await createStudentReq(
      { name: "Login Test", phone: "9800000402", email: "logintest@example.com" },
      token
    );
    expect(created.status).toBe(201);

    const sent = await request(app)
      .post("/api/auth/send-otp")
      .set("X-Forwarded-For", nextIp())
      .send({ phone: "9800000402" });
    expect(sent.status).toBe(200);
    expect(sent.body.devOtp).toMatch(/^\d{6}$/);

    const verified = await request(app)
      .post("/api/auth/verify-otp")
      .set("X-Forwarded-For", nextIp())
      .send({ phone: "9800000402", otp: sent.body.devOtp });
    expect(verified.status).toBe(200);
    expect(verified.body.user.role).toBe("student");
  });

  test("missing email → 400 (a student needs one to ever receive an OTP)", async () => {
    const token = await adminToken();
    const res = await createStudentReq({ name: "No Email", phone: "9800000403" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeTruthy();
  });

  test("invalid email format → 400", async () => {
    const token = await adminToken();
    const res = await createStudentReq({ name: "Bad Email", phone: "9800000404", email: "not-an-email" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeTruthy();
  });

  test("missing name → 400", async () => {
    const token = await adminToken();
    const res = await createStudentReq({ phone: "9800000405", email: "x@example.com" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.name).toBeTruthy();
  });

  test("missing/invalid phone → 400", async () => {
    const token = await adminToken();
    const res = await createStudentReq({ name: "Bad Phone", email: "x2@example.com" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.phone).toBeTruthy();
  });

  test("duplicate phone → 409, no second user created", async () => {
    const token = await adminToken();
    const existing = await createStudent({ phone: "9800000406" });

    const res = await createStudentReq({ name: "Someone Else", phone: "9800000406", email: "someone@example.com" }, token);
    expect(res.status).toBe(409);
    expect(await User.countDocuments({ phone: "9800000406" })).toBe(1);
    expect((await User.findById(existing._id)).name).toBe(existing.name);
  });

  test("duplicate email (different phone) → 409", async () => {
    const token = await adminToken();
    await createStudent({ phone: "9800000407", email: "shared2@example.com" });

    const res = await createStudentReq({ name: "Someone Else", phone: "9800000408", email: "shared2@example.com" }, token);
    expect(res.status).toBe(409);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    const res = await createStudentReq({ name: "X", phone: "9800000409", email: "x3@example.com" }, signToken(teacher));
    expect(res.status).toBe(403);
    expect(await User.findOne({ phone: "9800000409" })).toBeNull();
  });

  test("no token → 401", async () => {
    const res = await request(app).post("/api/admin/students").send({ name: "X", phone: "9800000410", email: "x4@example.com" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/students/:id", () => {
  test("admin token → 200 with the same aggregated shape as the list row", async () => {
    const token = await adminToken();
    const student = await createStudent({ name: "Priya", completedClassCount: 10 });

    const res = await request(app).get(`/api/admin/students/${student._id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.student).toMatchObject({ name: "Priya", completedClassCount: 10, assessmentsUnlocked: true, isActive: true });
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const res = await request(app).get(`/api/admin/students/${teacher._id}`).set("Authorization", `Bearer ${token}`); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const student = await createStudent();
    const res = await request(app).get(`/api/admin/students/${student._id}`).set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/admin/students/:id", () => {
  function patchStudent(id, body, token) {
    return request(app).patch(`/api/admin/students/${id}`).set("Authorization", `Bearer ${token}`).send(body);
  }

  test("valid edit → 200, persisted", async () => {
    const token = await adminToken();
    const student = await createStudent({ name: "Old", phone: "9800000501" });

    const res = await patchStudent(student._id, { name: "New", phone: "9800000502", email: "changed@example.com" }, token);
    expect(res.status).toBe(200);
    expect(res.body.student).toMatchObject({ name: "New", phone: "9800000502", email: "changed@example.com" });
  });

  test("email: \"\" is rejected — a student's email can never be cleared", async () => {
    const token = await adminToken();
    const student = await createStudent({ email: "keep@example.com" });

    const res = await patchStudent(student._id, { email: "" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeTruthy();
    expect((await User.findById(student._id)).email).toBe("keep@example.com");
  });

  test("duplicate email (another account's) → 409", async () => {
    const token = await adminToken();
    await createStudent({ email: "taken2@example.com" });
    const student = await createStudent({ email: "mine2@example.com" });

    const res = await patchStudent(student._id, { email: "taken2@example.com" }, token);
    expect(res.status).toBe(409);
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const res = await patchStudent(teacher._id, { name: "X" }, token); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const student = await createStudent();
    const res = await patchStudent(student._id, { name: "X" }, signToken(student));
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/admin/students/:id", () => {
  function deleteStudent(id, token, query = "") {
    return request(app).delete(`/api/admin/students/${id}${query}`).set("Authorization", `Bearer ${token}`);
  }

  test("no active enrollment → 200, soft-deleted", async () => {
    const token = await adminToken();
    const student = await createStudent();

    const res = await deleteStudent(student._id, token);
    expect(res.status).toBe(200);
    expect(res.body.student.isActive).toBe(false);
    expect((await User.findById(student._id)).isActive).toBe(false);
  });

  test("has an active enrollment → 409, not deactivated", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await deleteStudent(student._id, token);
    expect(res.status).toBe(409);
    expect((await User.findById(student._id)).isActive).not.toBe(false);
  });

  test("has an active enrollment but ?force=true → 200, deactivated anyway", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await deleteStudent(student._id, token, "?force=true");
    expect(res.status).toBe(200);
    expect((await User.findById(student._id)).isActive).toBe(false);
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const res = await deleteStudent(teacher._id, token); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const student = await createStudent();
    const res = await deleteStudent(student._id, signToken(student));
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const student = await createStudent();
    const res = await request(app).delete(`/api/admin/students/${student._id}`);
    expect(res.status).toBe(401);
  });
});

describe("deactivated users still appear in the list endpoints, badged via isActive", () => {
  test("GET /api/admin/teachers includes a deactivated teacher with isActive: false", async () => {
    const token = await adminToken();
    const teacher = await createTeacher({ name: "Deactivated Teacher" });
    await request(app).delete(`/api/admin/teachers/${teacher._id}`).set("Authorization", `Bearer ${token}`);

    const res = await request(app).get("/api/admin/teachers").set("Authorization", `Bearer ${token}`);
    const row = res.body.teachers.find((t) => t.name === "Deactivated Teacher");
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(false);
  });

  test("GET /api/admin/students includes a deactivated student with isActive: false", async () => {
    const token = await adminToken();
    const student = await createStudent({ name: "Deactivated Student" });
    await request(app).delete(`/api/admin/students/${student._id}`).set("Authorization", `Bearer ${token}`);

    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${token}`);
    const row = res.body.students.find((s) => s.name === "Deactivated Student");
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(false);
  });
});
