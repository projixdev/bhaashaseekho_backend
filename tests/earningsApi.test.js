// The read/settle surface around the payout ledger, plus the one hard
// boundary the whole feature carries: no rate, charged amount, or payout
// figure may ever reach a student, under any field name.
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
} from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: TeacherEarning } = await import("../src/models/TeacherEarning.js");
const { default: Enrollment } = await import("../src/models/Enrollment.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

async function adminToken() {
  const { user } = await createAdminUser();
  return signAdminToken(user);
}

// Runs a real class end-to-end so the ledger rows under test were written by
// the actual credit hook rather than hand-seeded into a shape it never
// produces.
async function teachClasses(teacher, student, { courseSlug = "kannada-speaking", perClassCharge = 500, count = 1 }) {
  await createEnrollment({ student, tutor: teacher, courseSlug, perClassCharge, classesRemaining: 20 });
  for (let i = 0; i < count; i++) {
    const cls = await createClass({ tutor: teacher, students: [student], courseSlug, scheduledAt: new Date() });
    await request(app)
      .patch(`/api/classes/${cls._id}/end`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ attendance: [{ studentId: student._id.toString(), status: "present" }] });
  }
}

describe("GET /api/teacher/earnings", () => {
  test("returns the teacher's own totals and entries, newest first", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await teachClasses(teacher, student, { perClassCharge: 500, count: 3 });

    const res = await request(app).get("/api/teacher/earnings").set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(200);
    expect(res.body.pointsPending).toBe(1200); // 3 x 400
    expect(res.body.pointsPaid).toBe(0);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.entries[0]).toMatchObject({ points: 400, chargedAmount: 500, status: "pending" });
    expect(res.body.hasMore).toBe(false);
  });

  test("never returns another teacher's rows", async () => {
    const mine = await createTeacher();
    const theirs = await createTeacher();
    await teachClasses(mine, await createStudent(), { perClassCharge: 500 });
    await teachClasses(theirs, await createStudent(), { courseSlug: "hindi-speaking", perClassCharge: 900 });

    const res = await request(app).get("/api/teacher/earnings").set("Authorization", `Bearer ${signToken(mine)}`);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.pointsPending).toBe(400); // not 400 + 720
  });

  test("totals are the exact sum of the rows they're drawn from, across a mix of statuses", async () => {
    const teacher = await createTeacher();
    await teachClasses(teacher, await createStudent(), { perClassCharge: 999, count: 4 });

    // Settle two of the four.
    const rows = await TeacherEarning.find({}).limit(2);
    await request(app)
      .patch("/api/admin/earnings/settle")
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ teacherId: teacher._id.toString(), entryIds: rows.map((r) => r._id.toString()) });

    const res = await request(app).get("/api/teacher/earnings").set("Authorization", `Bearer ${signToken(teacher)}`);
    // 799 each — integers throughout, so these sums are exact, not 1597.6.
    expect(res.body.pointsPaid).toBe(1598);
    expect(res.body.pointsPending).toBe(1598);
  });

  test("a student token → 403", async () => {
    const res = await request(app)
      .get("/api/teacher/earnings")
      .set("Authorization", `Bearer ${signToken(await createStudent())}`);
    expect(res.status).toBe(403);
  });

  test("no token → 401", async () => {
    expect((await request(app).get("/api/teacher/earnings")).status).toBe(401);
  });
});

describe("PATCH /api/admin/earnings/settle", () => {
  test("marks the selected rows paid and moves the exact amount out of pending", async () => {
    const teacher = await createTeacher();
    await teachClasses(teacher, await createStudent(), { perClassCharge: 500, count: 3 });
    const rows = await TeacherEarning.find({});

    const res = await request(app)
      .patch("/api/admin/earnings/settle")
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ teacherId: teacher._id.toString(), entryIds: [rows[0]._id.toString(), rows[1]._id.toString()] });

    expect(res.status).toBe(200);
    expect(res.body.settled).toBe(2);
    expect(res.body.pointsPaid).toBe(800);
    expect(res.body.pointsPending).toBe(400);
    expect((await TeacherEarning.findById(rows[0]._id)).paidAt).toBeTruthy();
    expect((await TeacherEarning.findById(rows[2]._id)).status).toBe("pending");
  });

  test("re-settling the same batch is a no-op — nothing is paid twice", async () => {
    const teacher = await createTeacher();
    await teachClasses(teacher, await createStudent(), { perClassCharge: 500, count: 2 });
    const entryIds = (await TeacherEarning.find({})).map((r) => r._id.toString());
    const token = await adminToken();
    const body = { teacherId: teacher._id.toString(), entryIds };

    const first = await request(app).patch("/api/admin/earnings/settle").set("Authorization", `Bearer ${token}`).send(body);
    expect(first.body.settled).toBe(2);

    const second = await request(app).patch("/api/admin/earnings/settle").set("Authorization", `Bearer ${token}`).send(body);
    expect(second.body.settled).toBe(0); // matched nothing — already paid
    expect(second.body.pointsPaid).toBe(800);
    expect(second.body.pointsPending).toBe(0);
  });

  test("two CONCURRENT settles of the same batch → settled counts sum to the batch size, never double it", async () => {
    const teacher = await createTeacher();
    await teachClasses(teacher, await createStudent(), { perClassCharge: 500, count: 3 });
    const entryIds = (await TeacherEarning.find({})).map((r) => r._id.toString());
    const token = await adminToken();
    const body = { teacherId: teacher._id.toString(), entryIds };

    const [a, b] = await Promise.all([
      request(app).patch("/api/admin/earnings/settle").set("Authorization", `Bearer ${token}`).send(body),
      request(app).patch("/api/admin/earnings/settle").set("Authorization", `Bearer ${token}`).send(body),
    ]);

    expect(a.body.settled + b.body.settled).toBe(3);
    expect(await TeacherEarning.countDocuments({ status: "paid" })).toBe(3);
  });

  test("an entryId belonging to another teacher is not settled by this teacher's batch", async () => {
    const mine = await createTeacher();
    const theirs = await createTeacher();
    await teachClasses(mine, await createStudent(), { perClassCharge: 500 });
    await teachClasses(theirs, await createStudent(), { courseSlug: "hindi-speaking", perClassCharge: 900 });

    const theirRow = await TeacherEarning.findOne({ teacher: theirs._id });
    const res = await request(app)
      .patch("/api/admin/earnings/settle")
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ teacherId: mine._id.toString(), entryIds: [theirRow._id.toString()] });

    expect(res.body.settled).toBe(0);
    expect((await TeacherEarning.findById(theirRow._id)).status).toBe("pending");
  });

  test("empty entryIds → 400", async () => {
    const res = await request(app)
      .patch("/api/admin/earnings/settle")
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ teacherId: (await createTeacher())._id.toString(), entryIds: [] });
    expect(res.status).toBe(400);
  });

  test("a teacher token → 403", async () => {
    const teacher = await createTeacher();
    const res = await request(app)
      .patch("/api/admin/earnings/settle")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ teacherId: teacher._id.toString(), entryIds: ["507f1f77bcf86cd799439011"] });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/earnings", () => {
  test("rolls up every teacher and lists entries across all of them", async () => {
    const a = await createTeacher();
    const b = await createTeacher();
    await teachClasses(a, await createStudent(), { perClassCharge: 500, count: 2 });
    await teachClasses(b, await createStudent(), { courseSlug: "hindi-speaking", perClassCharge: 1000 });

    const res = await request(app).get("/api/admin/earnings").set("Authorization", `Bearer ${await adminToken()}`);

    expect(res.status).toBe(200);
    const rollup = Object.fromEntries(res.body.teachers.map((t) => [t._id, t]));
    expect(rollup[a._id.toString()]).toMatchObject({ pointsPending: 800, pointsPaid: 0, pointsLifetime: 800 });
    expect(rollup[b._id.toString()]).toMatchObject({ pointsPending: 800, pointsPaid: 0, pointsLifetime: 800 });
    expect(res.body.entries).toHaveLength(3);
  });

  test("?teacherId= filters the entry list but leaves the roll-up whole", async () => {
    const a = await createTeacher();
    const b = await createTeacher();
    await teachClasses(a, await createStudent(), { perClassCharge: 500 });
    await teachClasses(b, await createStudent(), { courseSlug: "hindi-speaking", perClassCharge: 1000 });

    const res = await request(app)
      .get(`/api/admin/earnings?teacherId=${a._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`);

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].teacherId).toBe(a._id.toString());

    // The roll-up deliberately ignores the filter, so the page header keeps
    // showing what every teacher is owed while the list below is narrowed.
    // (The founder is a teacher account with isAdmin, so they're in this
    // list too — hence checking both teachers are present rather than the
    // list's exact length.)
    const rollup = Object.fromEntries(res.body.teachers.map((t) => [t._id, t.pointsPending]));
    expect(rollup[a._id.toString()]).toBe(400);
    expect(rollup[b._id.toString()]).toBe(800);
  });

  test("?status=paid returns only settled entries", async () => {
    const teacher = await createTeacher();
    await teachClasses(teacher, await createStudent(), { perClassCharge: 500, count: 2 });
    const token = await adminToken();
    const first = await TeacherEarning.findOne({});
    await request(app)
      .patch("/api/admin/earnings/settle")
      .set("Authorization", `Bearer ${token}`)
      .send({ teacherId: teacher._id.toString(), entryIds: [first._id.toString()] });

    const res = await request(app).get("/api/admin/earnings?status=paid").set("Authorization", `Bearer ${token}`);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].status).toBe("paid");
  });

  test("a teacher token → 403", async () => {
    const res = await request(app)
      .get("/api/admin/earnings")
      .set("Authorization", `Bearer ${signToken(await createTeacher())}`);
    expect(res.status).toBe(403);
  });
});

describe("admin enrollment pricing", () => {
  test("GET /api/admin/enrollments?studentId= returns the rate and remaining count", async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "kannada-speaking",
      perClassCharge: 750,
      classesRemaining: 6,
    });

    const res = await request(app)
      .get(`/api/admin/enrollments?studentId=${student._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.enrollments[0]).toMatchObject({ perClassCharge: 750, classesRemaining: 6, tutorName: teacher.name });
  });

  test("PATCH sets the rate and the remaining count, and persists both", async () => {
    const enrollment = await createEnrollment({
      student: await createStudent(),
      tutor: await createTeacher(),
      courseSlug: "hindi-speaking",
    });

    const res = await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ perClassCharge: 800, classesRemaining: 12 });

    expect(res.status).toBe(200);
    expect(res.body.enrollment).toMatchObject({ perClassCharge: 800, classesRemaining: 12 });
    expect(res.body.warning).toBeNull();

    const stored = await Enrollment.findById(enrollment._id).select("+perClassCharge");
    expect(stored.perClassCharge).toBe(800);
    expect(stored.classesRemaining).toBe(12);
  });

  test("classes remaining but no rate → still saved, with a warning rather than a rejection", async () => {
    const enrollment = await createEnrollment({
      student: await createStudent(),
      tutor: await createTeacher(),
      courseSlug: "hindi-speaking",
    });

    const res = await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ classesRemaining: 8 });

    expect(res.status).toBe(200);
    expect((await Enrollment.findById(enrollment._id)).classesRemaining).toBe(8);
    expect(res.body.warning).toMatch(/no per-class rate/i);
  });

  test("perClassCharge: null clears the rate back to unpriced", async () => {
    const enrollment = await createEnrollment({
      student: await createStudent(),
      tutor: await createTeacher(),
      courseSlug: "hindi-speaking",
      perClassCharge: 500,
    });

    await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ perClassCharge: null });

    expect((await Enrollment.findById(enrollment._id).select("+perClassCharge")).perClassCharge).toBeNull();
  });

  test.each([
    ["a fractional rate", { perClassCharge: 499.5 }, "perClassCharge"],
    ["a negative rate", { perClassCharge: -100 }, "perClassCharge"],
    ["a zero rate", { perClassCharge: 0 }, "perClassCharge"],
    ["a non-numeric rate", { perClassCharge: "lots" }, "perClassCharge"],
    ["a negative class count", { classesRemaining: -1 }, "classesRemaining"],
    ["a fractional class count", { classesRemaining: 2.5 }, "classesRemaining"],
  ])("%s → 400, nothing written", async (_label, body, field) => {
    const enrollment = await createEnrollment({
      student: await createStudent(),
      tutor: await createTeacher(),
      courseSlug: "hindi-speaking",
      perClassCharge: 500,
      classesRemaining: 3,
    });

    const res = await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.errors[field]).toBeTruthy();
    const stored = await Enrollment.findById(enrollment._id).select("+perClassCharge");
    expect(stored.perClassCharge).toBe(500);
    expect(stored.classesRemaining).toBe(3);
  });

  test("a tutor-only PATCH still works and leaves the rate alone (the pre-pricing call shape)", async () => {
    const nextTutor = await createTeacher();
    const enrollment = await createEnrollment({
      student: await createStudent(),
      tutor: await createTeacher(),
      courseSlug: "hindi-speaking",
      perClassCharge: 500,
      classesRemaining: 3,
    });

    const res = await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ tutorId: nextTutor._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.enrollment.tutorName).toBe(nextTutor.name);
    const stored = await Enrollment.findById(enrollment._id).select("+perClassCharge");
    expect(stored.perClassCharge).toBe(500);
    expect(stored.classesRemaining).toBe(3);
  });

  test("reassigning the tutor leaves already-earned rows with the teacher who earned them", async () => {
    const original = await createTeacher();
    const replacement = await createTeacher();
    const student = await createStudent();
    await teachClasses(original, student, { perClassCharge: 500, count: 2 });
    const enrollment = await Enrollment.findOne({ student: student._id });

    await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ tutorId: replacement._id.toString() });

    expect(await TeacherEarning.countDocuments({ teacher: original._id })).toBe(2);
    expect(await TeacherEarning.countDocuments({ teacher: replacement._id })).toBe(0);
  });

  test("a teacher token → 403 on both the read and the write", async () => {
    const teacher = await createTeacher();
    const enrollment = await createEnrollment({ student: await createStudent(), tutor: teacher, courseSlug: "hindi-speaking" });
    const auth = `Bearer ${signToken(teacher)}`;

    expect((await request(app).get(`/api/admin/enrollments?studentId=${enrollment.student}`).set("Authorization", auth)).status).toBe(403);
    expect(
      (await request(app).patch(`/api/admin/enrollments/${enrollment._id}`).set("Authorization", auth).send({ perClassCharge: 1 })).status
    ).toBe(403);
  });
});

// The one boundary that isn't negotiable: a student must never see the rate,
// the charged amount, or anything derived from them, under any field name.
// Asserted by scanning the whole serialised response rather than checking a
// list of known keys — a renamed or newly-added field would slip past the
// latter, which is exactly the failure this is guarding against.
describe("no money reaches a student", () => {
  const FORBIDDEN = /perClassCharge|chargedAmount|points|earning|payout|rate|amount|₹/i;

  test("every student-facing route is free of rate/payout data, even with a priced enrollment and real ledger rows", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await teachClasses(teacher, student, { perClassCharge: 500, count: 2 });
    const auth = `Bearer ${signToken(student)}`;

    for (const path of ["/api/enrollment/me", "/api/classes", "/api/assignments"]) {
      const res = await request(app).get(path).set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
    }
  });

  test("a student sees their remaining class count — a plain integer, with no rupee figure alongside it", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "kannada-speaking",
      perClassCharge: 500,
      classesRemaining: 4,
    });

    const res = await request(app).get("/api/enrollment/me").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.body.enrollments[0].classesRemaining).toBe(4);
    expect(res.body.enrollments[0].perClassCharge).toBeUndefined();
  });

  test("the teacher roster carries the remaining count but never the rate", async () => {
    const teacher = await createTeacher();
    await createEnrollment({
      student: await createStudent(),
      tutor: teacher,
      courseSlug: "kannada-speaking",
      perClassCharge: 500,
      classesRemaining: 4,
    });

    const res = await request(app).get("/api/roster").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.body.students[0].classesRemaining).toBe(4);
    expect(JSON.stringify(res.body)).not.toMatch(/perClassCharge|chargedAmount/i);
  });

  test("perClassCharge is select: false — a plain find() cannot serialise it", async () => {
    await createEnrollment({
      student: await createStudent(),
      tutor: await createTeacher(),
      courseSlug: "kannada-speaking",
      perClassCharge: 500,
    });

    const [naive] = await Enrollment.find({}).lean();
    expect(naive.perClassCharge).toBeUndefined();
    expect(naive.classesRemaining).toBe(0);
  });
});
