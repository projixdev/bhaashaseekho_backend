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

describe("POST /api/admin/teachers", () => {
  function createTeacherReq(body, token) {
    return request(app).post("/api/admin/teachers").set("Authorization", `Bearer ${token}`).send(body);
  }

  test("valid creation → 201, same shape a CLI-created teacher would have", async () => {
    const { user: admin } = await createAdminUser();
    const res = await createTeacherReq(
      { name: "New Teacher", phone: "9800000201", email: "newteacher@example.com" },
      signAdminToken(admin)
    );

    expect(res.status).toBe(201);
    expect(res.body.teacher).toMatchObject({ name: "New Teacher", phone: "9800000201", email: "newteacher@example.com" });

    const stored = await User.findOne({ phone: "9800000201" }).select("+password");
    expect(stored.role).toBe("teacher");
    expect(stored.isAdmin).toBe(false);
    expect(stored.password).toBeUndefined();
  });

  test("email is optional, matching createUser.js's --role teacher behavior", async () => {
    const { user: admin } = await createAdminUser();
    const res = await createTeacherReq({ name: "No Email Teacher", phone: "9800000202" }, signAdminToken(admin));
    expect(res.status).toBe(201);
    expect(res.body.teacher.email).toBeNull();
  });

  test("duplicate phone → 409, no second user created", async () => {
    const { user: admin } = await createAdminUser();
    const existing = await createTeacher({ phone: "9800000203" });

    const res = await createTeacherReq({ name: "Someone Else", phone: "9800000203" }, signAdminToken(admin));
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("This phone number is already registered.");

    expect(await User.countDocuments({ phone: "9800000203" })).toBe(1);
    expect((await User.findById(existing._id)).name).toBe(existing.name); // untouched, not overwritten
  });

  test("duplicate email (different phone) → 409 with an email-specific message", async () => {
    const { user: admin } = await createAdminUser();
    await createTeacher({ phone: "9800000204", email: "shared@example.com" });

    const res = await createTeacherReq(
      { name: "Someone Else", phone: "9800000205", email: "shared@example.com" },
      signAdminToken(admin)
    );
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("This email is already registered to another account.");
  });

  test("missing name → 400", async () => {
    const { user: admin } = await createAdminUser();
    const res = await createTeacherReq({ phone: "9800000206" }, signAdminToken(admin));
    expect(res.status).toBe(400);
    expect(res.body.errors.name).toBeTruthy();
  });

  test("missing/invalid phone → 400", async () => {
    const { user: admin } = await createAdminUser();
    const res = await createTeacherReq({ name: "Bad Phone" }, signAdminToken(admin));
    expect(res.status).toBe(400);
    expect(res.body.errors.phone).toBeTruthy();
  });

  test("invalid email format → 400", async () => {
    const { user: admin } = await createAdminUser();
    const res = await createTeacherReq(
      { name: "Bad Email", phone: "9800000207", email: "not-an-email" },
      signAdminToken(admin)
    );
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeTruthy();
  });

  test("no token → 401", async () => {
    const res = await request(app).post("/api/admin/teachers").send({ name: "X", phone: "9800000208" });
    expect(res.status).toBe(401);
  });

  test("non-admin token → 403", async () => {
    const teacher = await createTeacher();
    const res = await createTeacherReq({ name: "X", phone: "9800000209" }, signToken(teacher));
    expect(res.status).toBe(403);
    expect(await User.findOne({ phone: "9800000209" })).toBeNull();
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
    expect(row.assessmentsUnlockAt).toBe(10);
    expect(row.assessmentsUnlocked).toBe(true);
    expect(row.homework).toEqual({ assigned: 2, submitted: 1 });
    expect(row.assessments).toEqual({ assigned: 1, submitted: 0 });
    // homework has one still-"assigned" item -> overall status is "pending"
    // even though the assessment (submitted count 0 of 1... wait, A1 is
    // freshly created so it's "assigned" too) — both types have an
    // outstanding item, so pending is the only correct overall status here.
    expect(row.assignmentStatus).toBe("pending");
    expect(row.isTrial).toBe(true);
    expect(row.accessExpiresAt).toBeTruthy();
  });

  test("teachers[] lists every active enrollment's tutor, one per course, for students with more than one", async () => {
    const { user: admin } = await createAdminUser();
    const kannadaTeacher = await createTeacher({ name: "Sudi" });
    const hindiTeacher = await createTeacher({ name: "Pawan" });
    const student = await createStudent({ name: "Multi Course" });
    await createEnrollment({ student, tutor: kannadaTeacher, courseSlug: "kannada" });
    await createEnrollment({ student, tutor: hindiTeacher, courseSlug: "hindi" });

    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    const row = res.body.students.find((s) => s.name === "Multi Course");
    expect(row.teachers).toHaveLength(2);
    expect(row.teachers).toEqual(
      expect.arrayContaining([
        { courseSlug: "kannada", name: "Sudi" },
        { courseSlug: "hindi", name: "Pawan" },
      ])
    );
  });

  test("teachers[] is empty for a student with no active enrollment", async () => {
    const { user: admin } = await createAdminUser();
    await createStudent({ name: "No Enrollment" });

    const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    const row = res.body.students.find((s) => s.name === "No Enrollment");
    expect(row.teachers).toEqual([]);
  });

  describe("assignmentStatus priority (pending > submitted > reviewed > none)", () => {
    test("no assignments at all -> \"none\"", async () => {
      const { user: admin } = await createAdminUser();
      await createStudent({ name: "Zero Assignments" });

      const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
      const row = res.body.students.find((s) => s.name === "Zero Assignments");
      expect(row.assignmentStatus).toBe("none");
    });

    test("everything reviewed, nothing outstanding -> \"reviewed\"", async () => {
      const { user: admin } = await createAdminUser();
      const teacher = await createTeacher();
      const student = await createStudent({ name: "All Reviewed" });
      const hw = await createAssignmentDoc({ student, tutor: teacher, type: "homework", title: "HW" });
      hw.status = "reviewed";
      await hw.save();

      const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
      const row = res.body.students.find((s) => s.name === "All Reviewed");
      expect(row.assignmentStatus).toBe("reviewed");
    });

    test("at least one submitted, nothing still pending -> \"submitted\"", async () => {
      const { user: admin } = await createAdminUser();
      const teacher = await createTeacher();
      const student = await createStudent({ name: "Awaiting Review" });
      const reviewed = await createAssignmentDoc({ student, tutor: teacher, type: "homework", title: "HW1" });
      reviewed.status = "reviewed";
      await reviewed.save();
      const submitted = await createAssignmentDoc({ student, tutor: teacher, type: "assessment", title: "A1" });
      submitted.status = "submitted";
      await submitted.save();

      const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
      const row = res.body.students.find((s) => s.name === "Awaiting Review");
      expect(row.assignmentStatus).toBe("submitted");
    });

    test("at least one still \"assigned\" outranks submitted/reviewed -> \"pending\"", async () => {
      const { user: admin } = await createAdminUser();
      const teacher = await createTeacher();
      const student = await createStudent({ name: "Has Pending" });
      const reviewed = await createAssignmentDoc({ student, tutor: teacher, type: "homework", title: "HW1" });
      reviewed.status = "reviewed";
      await reviewed.save();
      await createAssignmentDoc({ student, tutor: teacher, type: "assessment", title: "A1" }); // stays "assigned"

      const res = await request(app).get("/api/admin/students").set("Authorization", `Bearer ${signAdminToken(admin)}`);
      const row = res.body.students.find((s) => s.name === "Has Pending");
      expect(row.assignmentStatus).toBe("pending");
    });
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
