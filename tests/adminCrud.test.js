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
  createClass,
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
const { default: Enrollment } = await import("../src/models/Enrollment.js");
const { default: Class } = await import("../src/models/Class.js");

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

  test("languages → 200, replaces the previous set entirely", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, { languages: ["kannada"] });

    const res = await patchTeacher(teacher._id, { languages: ["hindi", "telugu"] }, token);
    expect(res.status).toBe(200);
    expect(res.body.teacher.languages.sort()).toEqual(["hindi", "telugu"]);

    const stored = await User.findById(teacher._id);
    expect(stored.languages.sort()).toEqual(["hindi", "telugu"]);
  });

  test("unknown language → 400, previous languages untouched", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, { languages: ["kannada"] });

    const res = await patchTeacher(teacher._id, { languages: ["klingon"] }, token);
    expect(res.status).toBe(400);
    expect((await User.findById(teacher._id)).languages).toEqual(["kannada"]);
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

describe("PATCH /api/admin/teachers/:id/reactivate", () => {
  function reactivateTeacher(id, token) {
    return request(app).patch(`/api/admin/teachers/${id}/reactivate`).set("Authorization", `Bearer ${token}`);
  }

  test("deactivated teacher → 200, isActive: true again", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, { isActive: false });

    const res = await reactivateTeacher(teacher._id, token);
    expect(res.status).toBe(200);
    expect(res.body.teacher.isActive).toBe(true);
    expect((await User.findById(teacher._id)).isActive).toBe(true);
  });

  test("already-active teacher → 200, no-op", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();

    const res = await reactivateTeacher(teacher._id, token);
    expect(res.status).toBe(200);
    expect(res.body.teacher.isActive).toBe(true);
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const res = await reactivateTeacher(student._id, token); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, { isActive: false });
    const res = await reactivateTeacher(teacher._id, signToken(teacher));
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const teacher = await createTeacher();
    const res = await request(app).patch(`/api/admin/teachers/${teacher._id}/reactivate`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/students", () => {
  function createStudentReq(body, token) {
    return request(app).post("/api/admin/students").set("Authorization", `Bearer ${token}`).send(body);
  }

  const validBody = (overrides = {}) => ({
    name: "New Student",
    phone: "9800000401",
    email: "newstudent@example.com",
    accountType: "permanent",
    ...overrides,
  });

  test("valid creation, accountType permanent → 201, isTrial false, no expiry", async () => {
    const token = await adminToken();
    const res = await createStudentReq(validBody(), token);

    expect(res.status).toBe(201);
    expect(res.body.student).toMatchObject({
      name: "New Student",
      phone: "9800000401",
      email: "newstudent@example.com",
      accountType: "permanent",
      accessExpiresAt: null,
    });

    const stored = await User.findOne({ phone: "9800000401" }).select("+password");
    expect(stored.role).toBe("student");
    expect(stored.isAdmin).toBe(false);
    expect(stored.password).toBeUndefined();
    expect(stored.isTrial).toBe(false);
    expect(stored.accessExpiresAt).toBeNull();
  });

  test("accountType trial → 201, isTrial true, accessExpiresAt ~7 days out", async () => {
    const token = await adminToken();
    const before = Date.now();
    const res = await createStudentReq(validBody({ phone: "9800000420", accountType: "trial" }), token);
    const after = Date.now();

    expect(res.status).toBe(201);
    expect(res.body.student.accountType).toBe("trial");

    const stored = await User.findOne({ phone: "9800000420" });
    expect(stored.isTrial).toBe(true);
    const expiresAt = stored.accessExpiresAt.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000);
  });

  test("a freshly admin-created student can immediately log in via the existing OTP flow", async () => {
    const token = await adminToken();
    const created = await createStudentReq(validBody({ phone: "9800000402", email: "logintest@example.com" }), token);
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
    const res = await createStudentReq(validBody({ phone: "9800000403", email: undefined }), token);
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeTruthy();
  });

  test("invalid email format → 400", async () => {
    const token = await adminToken();
    const res = await createStudentReq(validBody({ phone: "9800000404", email: "not-an-email" }), token);
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeTruthy();
  });

  test("missing name → 400", async () => {
    const token = await adminToken();
    const res = await createStudentReq(validBody({ phone: "9800000405", name: undefined }), token);
    expect(res.status).toBe(400);
    expect(res.body.errors.name).toBeTruthy();
  });

  test("missing/invalid phone → 400", async () => {
    const token = await adminToken();
    const res = await createStudentReq(validBody({ phone: undefined }), token);
    expect(res.status).toBe(400);
    expect(res.body.errors.phone).toBeTruthy();
  });

  test("missing accountType → 400", async () => {
    const token = await adminToken();
    const res = await createStudentReq(validBody({ phone: "9800000421", accountType: undefined }), token);
    expect(res.status).toBe(400);
    expect(res.body.errors.accountType).toBeTruthy();
  });

  test('invalid accountType (not "trial"/"permanent") → 400', async () => {
    const token = await adminToken();
    const res = await createStudentReq(validBody({ phone: "9800000422", accountType: "lifetime" }), token);
    expect(res.status).toBe(400);
    expect(res.body.errors.accountType).toBeTruthy();
  });

  test("duplicate phone → 409, no second user created", async () => {
    const token = await adminToken();
    const existing = await createStudent({ phone: "9800000406" });

    const res = await createStudentReq(validBody({ phone: "9800000406", email: "someone@example.com" }), token);
    expect(res.status).toBe(409);
    expect(await User.countDocuments({ phone: "9800000406" })).toBe(1);
    expect((await User.findById(existing._id)).name).toBe(existing.name);
  });

  test("duplicate email (different phone) → 409", async () => {
    const token = await adminToken();
    await createStudent({ phone: "9800000407", email: "shared2@example.com" });

    const res = await createStudentReq(validBody({ phone: "9800000408", email: "shared2@example.com" }), token);
    expect(res.status).toBe(409);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    const res = await createStudentReq(validBody({ phone: "9800000409", email: "x3@example.com" }), signToken(teacher));
    expect(res.status).toBe(403);
    expect(await User.findOne({ phone: "9800000409" })).toBeNull();
  });

  test("no token → 401", async () => {
    const res = await request(app).post("/api/admin/students").send(validBody({ phone: "9800000410", email: "x4@example.com" }));
    expect(res.status).toBe(401);
  });

  // Phase 21: creating a student and enrolling them in one or more courses
  // (each with its own tutor) in the same submission, instead of a separate
  // manual "Manage Enrollments" step afterward.
  test("multi-course-in-one-submit: creates the student and one Enrollment per course, each with its own tutor", async () => {
    const token = await adminToken();
    const kannadaTutor = await createTeacher({ name: "Kannada Tutor" });
    const hindiTutor = await createTeacher({ name: "Hindi Tutor" });

    const res = await createStudentReq(
      validBody({
        phone: "9800000501",
        courses: [
          { courseSlug: "kannada-speaking", tutorId: kannadaTutor._id.toString() },
          { courseSlug: "hindi-academics", tutorId: hindiTutor._id.toString() },
        ],
      }),
      token
    );

    expect(res.status).toBe(201);
    const student = await User.findOne({ phone: "9800000501" });
    expect(res.body.enrollments).toHaveLength(2);
    expect(res.body.enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ courseSlug: "kannada-speaking", tutorId: kannadaTutor._id.toString() }),
        expect.objectContaining({ courseSlug: "hindi-academics", tutorId: hindiTutor._id.toString() }),
      ])
    );

    const stored = await Enrollment.find({ student: student._id }).lean();
    expect(stored).toHaveLength(2);
    expect(stored.every((e) => e.status === "active")).toBe(true);
  });

  test("courses is entirely optional — a student can still be created with none, same as before this phase", async () => {
    const token = await adminToken();
    const res = await createStudentReq(validBody({ phone: "9800000502" }), token);
    expect(res.status).toBe(201);
    expect(res.body.enrollments).toEqual([]);
  });

  test("no-tutor-selected-rejection: a course with no tutorId → 400, nothing created", async () => {
    const token = await adminToken();
    const res = await createStudentReq(
      validBody({ phone: "9800000503", courses: [{ courseSlug: "kannada-speaking", tutorId: "" }] }),
      token
    );

    expect(res.status).toBe(400);
    expect(res.body.errors["courses.0.tutorId"]).toBeTruthy();
    expect(await User.findOne({ phone: "9800000503" })).toBeNull();
  });

  test("duplicate-enrollment-rejection: the same courseSlug selected twice in one submission → 400, nothing created", async () => {
    const token = await adminToken();
    const tutor1 = await createTeacher();
    const tutor2 = await createTeacher();

    const res = await createStudentReq(
      validBody({
        phone: "9800000504",
        courses: [
          { courseSlug: "kannada-speaking", tutorId: tutor1._id.toString() },
          { courseSlug: "kannada-speaking", tutorId: tutor2._id.toString() },
        ],
      }),
      token
    );

    expect(res.status).toBe(400);
    expect(res.body.errors["courses.1.courseSlug"]).toBeTruthy();
    expect(await User.findOne({ phone: "9800000504" })).toBeNull();
    expect(await Enrollment.countDocuments()).toBe(0);
  });

  test("tutorId pointing at a student, not a teacher → 400, nothing created", async () => {
    const token = await adminToken();
    const notATeacher = await createStudent();

    const res = await createStudentReq(
      validBody({ phone: "9800000505", courses: [{ courseSlug: "kannada-speaking", tutorId: notATeacher._id.toString() }] }),
      token
    );

    expect(res.status).toBe(400);
    expect(res.body.errors["courses.0.tutorId"]).toBeTruthy();
    expect(await User.findOne({ phone: "9800000505" })).toBeNull();
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

  test("accountType: permanent converts an existing trial student — clears accessExpiresAt", async () => {
    const token = await adminToken();
    const student = await createStudent({ isTrial: true, accessExpiresAt: new Date(Date.now() + 1000) });

    const res = await patchStudent(student._id, { accountType: "permanent" }, token);
    expect(res.status).toBe(200);
    expect(res.body.student).toMatchObject({ accountType: "permanent", accessExpiresAt: null });

    const stored = await User.findById(student._id);
    expect(stored.isTrial).toBe(false);
    expect(stored.accessExpiresAt).toBeNull();
  });

  test("accountType: trial converts an existing permanent student — sets a fresh 7-day window from now", async () => {
    const token = await adminToken();
    const student = await createStudent({ isTrial: false });
    const before = Date.now();

    const res = await patchStudent(student._id, { accountType: "trial" }, token);
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.body.student.accountType).toBe("trial");

    const stored = await User.findById(student._id);
    expect(stored.isTrial).toBe(true);
    const expiresAt = stored.accessExpiresAt.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000);
  });

  test('invalid accountType → 400, nothing changed', async () => {
    const token = await adminToken();
    const student = await createStudent({ isTrial: false });

    const res = await patchStudent(student._id, { accountType: "forever" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.accountType).toBeTruthy();
    expect((await User.findById(student._id)).isTrial).toBe(false);
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

describe("PATCH /api/admin/students/:id/reactivate", () => {
  function reactivateStudent(id, token) {
    return request(app).patch(`/api/admin/students/${id}/reactivate`).set("Authorization", `Bearer ${token}`);
  }

  test("deactivated student → 200, isActive: true again", async () => {
    const token = await adminToken();
    const student = await createStudent();
    await User.findByIdAndUpdate(student._id, { isActive: false });

    const res = await reactivateStudent(student._id, token);
    expect(res.status).toBe(200);
    expect(res.body.student.isActive).toBe(true);
    expect((await User.findById(student._id)).isActive).toBe(true);
  });

  test("already-active student → 200, no-op", async () => {
    const token = await adminToken();
    const student = await createStudent();

    const res = await reactivateStudent(student._id, token);
    expect(res.status).toBe(200);
    expect(res.body.student.isActive).toBe(true);
  });

  test("unknown id → 404", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const res = await reactivateStudent(teacher._id, token); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const student = await createStudent();
    await User.findByIdAndUpdate(student._id, { isActive: false });
    const res = await reactivateStudent(student._id, signToken(student));
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const student = await createStudent();
    const res = await request(app).patch(`/api/admin/students/${student._id}/reactivate`);
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

describe("POST /api/admin/students/:id/enrollments", () => {
  function enrollReq(studentId, body, token) {
    return request(app).post(`/api/admin/students/${studentId}/enrollments`).set("Authorization", `Bearer ${token}`).send(body);
  }

  test("valid enrollment → 201, enrollment created with the chosen course/tutor", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const tutor = await createTeacher({ name: "Founder" });

    const res = await enrollReq(student._id, { courseSlug: "Kannada", tutorId: tutor._id.toString() }, token);
    expect(res.status).toBe(201);
    expect(res.body.enrollment).toMatchObject({ courseSlug: "kannada", tutorId: tutor._id.toString(), tutorName: "Founder" });

    const stored = await Enrollment.findOne({ student: student._id, courseSlug: "kannada" });
    expect(stored).not.toBeNull();
    expect(stored.tutor.toString()).toBe(tutor._id.toString());
    expect(stored.status).toBe("active");
  });

  test("a second course for the same student creates a second, independent enrollment", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const tutor1 = await createTeacher();
    const tutor2 = await createTeacher();

    await enrollReq(student._id, { courseSlug: "kannada", tutorId: tutor1._id.toString() }, token);
    const res = await enrollReq(student._id, { courseSlug: "hindi", tutorId: tutor2._id.toString() }, token);
    expect(res.status).toBe(201);

    expect(await Enrollment.countDocuments({ student: student._id })).toBe(2);
  });

  test("re-enrolling in the same course updates the tutor instead of erroring", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const original = await createTeacher();
    const replacement = await createTeacher();

    await enrollReq(student._id, { courseSlug: "kannada", tutorId: original._id.toString() }, token);
    const res = await enrollReq(student._id, { courseSlug: "kannada", tutorId: replacement._id.toString() }, token);
    expect(res.status).toBe(201);

    expect(await Enrollment.countDocuments({ student: student._id, courseSlug: "kannada" })).toBe(1);
    const stored = await Enrollment.findOne({ student: student._id, courseSlug: "kannada" });
    expect(stored.tutor.toString()).toBe(replacement._id.toString());
  });

  test("missing courseSlug → 400", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const tutor = await createTeacher();

    const res = await enrollReq(student._id, { tutorId: tutor._id.toString() }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.courseSlug).toBeTruthy();
  });

  test("missing tutorId → 400", async () => {
    const token = await adminToken();
    const student = await createStudent();

    const res = await enrollReq(student._id, { courseSlug: "kannada" }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.tutorId).toBeTruthy();
  });

  test("tutorId pointing at a student, not a teacher → 400", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const notATeacher = await createStudent();

    const res = await enrollReq(student._id, { courseSlug: "kannada", tutorId: notATeacher._id.toString() }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.tutorId).toBeTruthy();
  });

  test("unknown student id → 404", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    const tutor = await createTeacher();

    const res = await enrollReq(teacher._id, { courseSlug: "kannada", tutorId: tutor._id.toString() }, token); // wrong role
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const student = await createStudent();
    const tutor = await createTeacher();
    const res = await enrollReq(student._id, { courseSlug: "kannada", tutorId: tutor._id.toString() }, signToken(tutor));
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const student = await createStudent();
    const res = await request(app).post(`/api/admin/students/${student._id}/enrollments`).send({ courseSlug: "kannada" });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/admin/enrollments/:id — reassign tutor (founder-hands-off-to-a-permanent-tutor flow)", () => {
  function reassignReq(enrollmentId, body, token) {
    return request(app).patch(`/api/admin/enrollments/${enrollmentId}`).set("Authorization", `Bearer ${token}`).send(body);
  }

  test("valid reassignment → 200, tutor updated", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const founder = await createTeacher({ name: "Founder" });
    const newTutor = await createTeacher({ name: "New Tutor" });
    const enrollment = await createEnrollment({ student, tutor: founder });

    const res = await reassignReq(enrollment._id, { tutorId: newTutor._id.toString() }, token);
    expect(res.status).toBe(200);
    expect(res.body.enrollment).toMatchObject({ tutorId: newTutor._id.toString(), tutorName: "New Tutor" });

    const stored = await Enrollment.findById(enrollment._id);
    expect(stored.tutor.toString()).toBe(newTutor._id.toString());
  });

  test("past classes keep their original tutor — reassignment never rewrites class history", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const founder = await createTeacher();
    const newTutor = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor: founder });
    const pastClass = await createClass({ tutor: founder, students: [student], scheduledAt: new Date(), status: "completed" });

    await reassignReq(enrollment._id, { tutorId: newTutor._id.toString() }, token);

    const storedClass = await Class.findById(pastClass._id);
    expect(storedClass.tutor.toString()).toBe(founder._id.toString());
  });

  test("missing tutorId → 400", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const founder = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor: founder });

    const res = await reassignReq(enrollment._id, {}, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.tutorId).toBeTruthy();
  });

  test("unknown enrollment id → 404", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const res = await reassignReq(student._id, { tutorId: student._id.toString() }, token); // not a real enrollment id
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const student = await createStudent();
    const founder = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor: founder });

    const res = await reassignReq(enrollment._id, { tutorId: founder._id.toString() }, signToken(founder));
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    const student = await createStudent();
    const founder = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor: founder });

    const res = await request(app).patch(`/api/admin/enrollments/${enrollment._id}`).send({ tutorId: founder._id.toString() });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/admin/enrollments/:id — Phase 21 Part 4, removing a course", () => {
  function deleteReq(enrollmentId, token) {
    return request(app).delete(`/api/admin/enrollments/${enrollmentId}`).set("Authorization", `Bearer ${token}`);
  }

  test("valid delete → 200, the Enrollment doc is gone", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const tutor = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor });

    const res = await deleteReq(enrollment._id, token);
    expect(res.status).toBe(200);
    expect(await Enrollment.findById(enrollment._id)).toBeNull();
  });

  test("a student's past classes/assignments are untouched by removing their enrollment", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const tutor = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor });
    const pastClass = await createClass({ tutor, students: [student], scheduledAt: new Date(), status: "completed" });

    await deleteReq(enrollment._id, token);

    expect(await Class.findById(pastClass._id)).not.toBeNull();
  });

  test("unknown enrollment id → 404", async () => {
    const token = await adminToken();
    const student = await createStudent();
    const res = await deleteReq(student._id, token); // not a real enrollment id
    expect(res.status).toBe(404);
  });

  test("non-admin token → 403, enrollment untouched", async () => {
    const student = await createStudent();
    const tutor = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor });

    const res = await deleteReq(enrollment._id, signToken(tutor));
    expect(res.status).toBe(403);
    expect(await Enrollment.findById(enrollment._id)).not.toBeNull();
  });

  test("no token → 401", async () => {
    const student = await createStudent();
    const tutor = await createTeacher();
    const enrollment = await createEnrollment({ student, tutor });

    const res = await request(app).delete(`/api/admin/enrollments/${enrollment._id}`);
    expect(res.status).toBe(401);
  });
});

// Phase 22 course discovery: admin approving/rejecting a teacher's "I can
// teach this" request. GET /api/admin/teachers (and the single-teacher GET)
// already carry teachableCourses via buildTeacherRows — covered implicitly
// by the shape assertion in the first describe block above; these tests
// focus on the two new mutating routes.
describe("PATCH /api/admin/teachers/:id/teachable-courses/:courseSlug (approve)", () => {
  test("admin token → 200, that entry flips to approved, others untouched", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, {
      teachableCourses: [
        { courseSlug: "kannada-speaking", status: "pending" },
        { courseSlug: "hindi-academics", status: "pending" },
      ],
    });

    const res = await request(app)
      .patch(`/api/admin/teachers/${teacher._id}/teachable-courses/kannada-speaking`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const stored = await User.findById(teacher._id).lean();
    expect(stored.teachableCourses).toEqual(
      expect.arrayContaining([
        { courseSlug: "kannada-speaking", status: "approved" },
        { courseSlug: "hindi-academics", status: "pending" },
      ])
    );
  });

  test("courseSlug the teacher never requested → 404", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();

    const res = await request(app)
      .patch(`/api/admin/teachers/${teacher._id}/teachable-courses/kannada-speaking`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, { teachableCourses: [{ courseSlug: "kannada-speaking", status: "pending" }] });

    const res = await request(app)
      .patch(`/api/admin/teachers/${teacher._id}/teachable-courses/kannada-speaking`)
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/admin/teachers/:id/teachable-courses/:courseSlug (reject)", () => {
  test("admin token → 200, entry removed entirely (not marked rejected)", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();
    await User.findByIdAndUpdate(teacher._id, {
      teachableCourses: [{ courseSlug: "kannada-speaking", status: "pending" }],
    });

    const res = await request(app)
      .delete(`/api/admin/teachers/${teacher._id}/teachable-courses/kannada-speaking`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const stored = await User.findById(teacher._id);
    expect(stored.teachableCourses).toEqual([]);
  });

  test("courseSlug the teacher never requested → 404", async () => {
    const token = await adminToken();
    const teacher = await createTeacher();

    const res = await request(app)
      .delete(`/api/admin/teachers/${teacher._id}/teachable-courses/kannada-speaking`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test("no token → 401", async () => {
    const teacher = await createTeacher();
    const res = await request(app).delete(`/api/admin/teachers/${teacher._id}/teachable-courses/kannada-speaking`);
    expect(res.status).toBe(401);
  });
});
