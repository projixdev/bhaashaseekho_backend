// Phase 4 — the teacher payout ledger written by classController.endClass.
//
// The concurrency test comes first on purpose: exactly-once crediting is the
// one property here that can be silently wrong (a double-credit looks like a
// working feature until payout day), and it's enforced by TeacherEarning's
// unique (classId, student) index rather than by endClass's class-level
// guard — that guard protects the Class document and deliberately lets a
// retry through for auto-completed classes, so it can't be what protects a
// payout. These tests exercise the index, not the timing.
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
const { runAutoCompleteClassesTick } = await import("../src/jobs/autoCompleteClasses.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function endClass(teacher, classId, attendance) {
  return request(app)
    .patch(`/api/classes/${classId}/end`)
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ attendance });
}

// The standard setup for these tests: one priced enrollment, one class
// attributed to its course, one student.
async function seedPricedClass({ perClassCharge = 500, classesRemaining = 4, courseSlug = "kannada-speaking" } = {}) {
  const teacher = await createTeacher();
  const student = await createStudent();
  const enrollment = await createEnrollment({ student, tutor: teacher, courseSlug, perClassCharge, classesRemaining });
  const cls = await createClass({ tutor: teacher, students: [student], courseSlug, scheduledAt: new Date() });
  return { teacher, student, enrollment, cls, present: [{ studentId: student._id.toString(), status: "present" }] };
}

async function adminToken() {
  const { user } = await createAdminUser();
  return signAdminToken(user);
}

describe("exactly-once crediting", () => {
  test("two CONCURRENT endClass calls on the same class → exactly one ledger row and exactly one -1 on classesRemaining", async () => {
    const { teacher, cls, present, enrollment } = await seedPricedClass({ perClassCharge: 500, classesRemaining: 4 });

    const [a, b] = await Promise.all([endClass(teacher, cls._id, present), endClass(teacher, cls._id, present)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const rows = await TeacherEarning.find({ classId: cls._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].points).toBe(400);

    expect((await Enrollment.findById(enrollment._id)).classesRemaining).toBe(3);
  });

  test("sequential retry → second call 409s, ledger and classesRemaining unchanged", async () => {
    const { teacher, cls, present, enrollment } = await seedPricedClass({ classesRemaining: 4 });

    expect((await endClass(teacher, cls._id, present)).status).toBe(200);
    expect((await endClass(teacher, cls._id, present)).status).toBe(409);

    expect(await TeacherEarning.countDocuments({ classId: cls._id })).toBe(1);
    expect((await Enrollment.findById(enrollment._id)).classesRemaining).toBe(3);
  });

  // The one path that legitimately reaches the credit hook twice for the
  // same class: autoCompleteClasses closes a stale class as everyone-absent,
  // then the tutor corrects the attendance. The class-level guard lets that
  // second request through by design, so the ledger index is the only thing
  // standing between it and a double-credit.
  test("auto-completed class then corrected by the tutor → credited once, not twice", async () => {
    const { teacher, cls, present, enrollment } = await seedPricedClass({ classesRemaining: 4 });

    // Push the clock past the class's slot + grace period so the job claims
    // it, then let the tutor retroactively mark the student present.
    await runAutoCompleteClassesTick(new Date(Date.now() + 3 * 60 * 60 * 1000));
    expect(await TeacherEarning.countDocuments({})).toBe(0); // everyone absent — nothing earned

    expect((await endClass(teacher, cls._id, present)).status).toBe(200);
    expect(await TeacherEarning.countDocuments({ classId: cls._id })).toBe(1);

    // And still only once if that correction is itself retried.
    await endClass(teacher, cls._id, present);
    expect(await TeacherEarning.countDocuments({ classId: cls._id })).toBe(1);
    expect((await Enrollment.findById(enrollment._id)).classesRemaining).toBe(3);
  });

  test("a group class credits each present student once, and skips the absent one", async () => {
    const teacher = await createTeacher();
    const alice = await createStudent();
    const bob = await createStudent();
    const carol = await createStudent();
    for (const [student, rate] of [
      [alice, 500],
      [bob, 1000],
      [carol, 700],
    ]) {
      await createEnrollment({
        student,
        tutor: teacher,
        courseSlug: "hindi-speaking",
        perClassCharge: rate,
        classesRemaining: 2,
      });
    }
    const cls = await createClass({
      tutor: teacher,
      students: [alice, bob, carol],
      courseSlug: "hindi-speaking",
      scheduledAt: new Date(),
    });

    const res = await endClass(teacher, cls._id, [
      { studentId: alice._id.toString(), status: "present" },
      { studentId: bob._id.toString(), status: "present" },
      { studentId: carol._id.toString(), status: "absent" },
    ]);
    expect(res.status).toBe(200);

    // Per-student rates, so each row is priced from its own enrollment —
    // not one rate applied across the whole class.
    const rows = await TeacherEarning.find({ classId: cls._id }).sort({ points: 1 });
    expect(rows.map((r) => r.points)).toEqual([400, 800]);
    expect(await TeacherEarning.countDocuments({ student: carol._id })).toBe(0);
    expect((await Enrollment.findOne({ student: carol._id })).classesRemaining).toBe(2); // untouched
  });
});

describe("what gets charged, and against which enrollment", () => {
  test("points are 80% of that student's own rate, rounded to a whole number", async () => {
    // 999 * 0.8 = 799.2 — rounded once, at credit time, and stored.
    const { teacher, cls, present } = await seedPricedClass({ perClassCharge: 999 });
    await endClass(teacher, cls._id, present);

    const row = await TeacherEarning.findOne({ classId: cls._id });
    expect(row.chargedAmount).toBe(999);
    expect(row.points).toBe(799);
  });

  test("an unpriced enrollment → class completes clean, no ledger row, classesRemaining untouched", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const enrollment = await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "telugu-speaking",
      classesRemaining: 3,
    });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      courseSlug: "telugu-speaking",
      scheduledAt: new Date(),
    });

    const res = await endClass(teacher, cls._id, [{ studentId: student._id.toString(), status: "present" }]);
    expect(res.status).toBe(200);
    expect(res.body.class.status).toBe("completed");

    expect(await TeacherEarning.countDocuments({})).toBe(0);
    expect((await Enrollment.findById(enrollment._id)).classesRemaining).toBe(3);
  });

  test("a student with two courses under the same teacher is charged against the class's own course only", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const speaking = await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "kannada-speaking",
      perClassCharge: 500,
      classesRemaining: 5,
    });
    const writing = await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "kannada-reading-writing",
      perClassCharge: 900,
      classesRemaining: 5,
    });
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      courseSlug: "kannada-reading-writing",
      scheduledAt: new Date(),
    });

    await endClass(teacher, cls._id, [{ studentId: student._id.toString(), status: "present" }]);

    const row = await TeacherEarning.findOne({ classId: cls._id });
    expect(row.chargedAmount).toBe(900);
    expect(row.courseSlug).toBe("kannada-reading-writing");
    expect((await Enrollment.findById(writing._id)).classesRemaining).toBe(4);
    expect((await Enrollment.findById(speaking._id)).classesRemaining).toBe(5); // the other course is untouched
  });

  test("a legacy class with no courseSlug still credits when the student has exactly one enrollment with that teacher", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "kannada-speaking",
      perClassCharge: 500,
      classesRemaining: 2,
    });
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date() }); // no courseSlug

    await endClass(teacher, cls._id, [{ studentId: student._id.toString(), status: "present" }]);
    expect((await TeacherEarning.findOne({ classId: cls._id })).points).toBe(400);
  });

  test("a legacy class with no courseSlug and an ambiguous enrollment credits nothing rather than guessing a rate", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "kannada-speaking",
      perClassCharge: 500,
      classesRemaining: 5,
    });
    await createEnrollment({
      student,
      tutor: teacher,
      courseSlug: "kannada-academics",
      perClassCharge: 900,
      classesRemaining: 5,
    });
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: new Date() });

    const res = await endClass(teacher, cls._id, [{ studentId: student._id.toString(), status: "present" }]);
    expect(res.status).toBe(200); // the class still completes; only the credit is skipped
    expect(await TeacherEarning.countDocuments({})).toBe(0);
    const remaining = await Enrollment.find({ student: student._id });
    expect(remaining.map((e) => e.classesRemaining)).toEqual([5, 5]);
  });

  test("classesRemaining floors at 0 — a class run past the package still pays the teacher", async () => {
    const { teacher, cls, present, enrollment } = await seedPricedClass({ classesRemaining: 0 });

    await endClass(teacher, cls._id, present);

    expect((await Enrollment.findById(enrollment._id)).classesRemaining).toBe(0); // never negative
    expect((await TeacherEarning.findOne({ classId: cls._id })).points).toBe(400);
  });

  test("partial and absent earn nothing", async () => {
    const teacher = await createTeacher();
    const partial = await createStudent();
    const absent = await createStudent();
    for (const student of [partial, absent]) {
      await createEnrollment({
        student,
        tutor: teacher,
        courseSlug: "hindi-academics",
        perClassCharge: 500,
        classesRemaining: 3,
      });
    }
    const cls = await createClass({
      tutor: teacher,
      students: [partial, absent],
      courseSlug: "hindi-academics",
      scheduledAt: new Date(),
    });

    await endClass(teacher, cls._id, [
      { studentId: partial._id.toString(), status: "partial" },
      { studentId: absent._id.toString(), status: "absent" },
    ]);

    expect(await TeacherEarning.countDocuments({})).toBe(0);
    const rows = await Enrollment.find({});
    expect(rows.map((e) => e.classesRemaining)).toEqual([3, 3]);
  });
});

describe("who gets paid", () => {
  // The class record says who taught it; the enrollment says who holds the
  // student now. Those diverge the moment an admin hands a student over, and
  // the credit has to follow the class, not the enrollment.
  test("a tutor reassigned before the class is ended → the teacher who actually taught it is credited", async () => {
    const original = await createTeacher();
    const replacement = await createTeacher();
    const student = await createStudent();
    const enrollment = await createEnrollment({
      student,
      tutor: original,
      courseSlug: "kannada-speaking",
      perClassCharge: 500,
      classesRemaining: 5,
    });
    const cls = await createClass({
      tutor: original,
      students: [student],
      courseSlug: "kannada-speaking",
      scheduledAt: new Date(),
    });

    // Handed over after the class was taught but before it was ended.
    await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${await adminToken()}`)
      .send({ tutorId: replacement._id.toString() });

    expect((await endClass(original, cls._id, [{ studentId: student._id.toString(), status: "present" }])).status).toBe(200);

    const row = await TeacherEarning.findOne({ classId: cls._id });
    expect(row.teacher.toString()).toBe(original._id.toString());
    expect(row.points).toBe(400);
    expect(await TeacherEarning.countDocuments({ teacher: replacement._id })).toBe(0);
  });
});

describe("the snapshot is immutable", () => {
  test("editing a student's rate afterwards never reprices classes that already ran", async () => {
    const { teacher, student, enrollment, present, cls } = await seedPricedClass({
      perClassCharge: 500,
      classesRemaining: 10,
    });
    await endClass(teacher, cls._id, present);

    // Admin doubles the rate.
    const token = await adminToken();
    const patch = await request(app)
      .patch(`/api/admin/enrollments/${enrollment._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ perClassCharge: 1000 });
    expect(patch.status).toBe(200);

    // The already-written row is untouched...
    const old = await TeacherEarning.findOne({ classId: cls._id });
    expect(old.chargedAmount).toBe(500);
    expect(old.points).toBe(400);

    // ...and only the next class uses the new rate.
    const next = await createClass({
      tutor: teacher,
      students: [student],
      courseSlug: "kannada-speaking",
      scheduledAt: new Date(),
    });
    await endClass(teacher, next._id, present);
    expect((await TeacherEarning.findOne({ classId: next._id })).points).toBe(800);
  });
});
