// jobs/autoCompleteClasses.js — closes out classes whose slot (scheduledAt +
// durationMinutes + 30min grace) has passed without the tutor running End
// Class, marking every enrolled student absent. Idempotency mirrors
// endClass: a class is auto-closed exactly once even under overlapping
// ticks, and one already ended in-app is never touched. Plus the tutor's
// retroactive-correction path through End Class on a system record.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createClass, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: Class } = await import("../src/models/Class.js");
const { default: User } = await import("../src/models/User.js");
const { runAutoCompleteClassesTick } = await import("../src/jobs/autoCompleteClasses.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

// scheduledAt far enough back that scheduledAt + duration + 30min grace is
// comfortably before `now`.
function stale(now, durationMinutes = 45) {
  return new Date(now.getTime() - (durationMinutes + 30 + 5) * 60 * 1000);
}

describe("runAutoCompleteClassesTick", () => {
  test("class past its grace period with no End Class → completed, everyone absent, marked by system", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const s1 = await createStudent();
    const s2 = await createStudent();
    const cls = await createClass({ tutor: teacher, students: [s1, s2], scheduledAt: stale(now) });

    const result = await runAutoCompleteClassesTick(now);
    expect(result.completed).toBe(1);

    const reloaded = await Class.findById(cls._id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.attendanceMarkedBy).toBe("system");
    expect(reloaded.attendance.map((a) => `${a.student}:${a.status}`).sort()).toEqual(
      [`${s1._id}:absent`, `${s2._id}:absent`].sort()
    );
  });

  test("class still within the grace period → untouched", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    // 45-min class that started 50 min ago: ended 5 min ago, 30-min grace still running.
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date(now.getTime() - 50 * 60 * 1000),
    });

    const result = await runAutoCompleteClassesTick(now);
    expect(result.completed).toBe(0);
    expect((await Class.findById(cls._id)).status).toBe("upcoming");
  });

  test("a class already ended via End Class → never touched", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: stale(now),
      attendance: [{ studentId: student._id.toString(), status: "present" }],
    });

    const result = await runAutoCompleteClassesTick(now);
    expect(result.completed).toBe(0);

    const reloaded = await Class.findById(cls._id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.attendance).toHaveLength(1);
    expect(reloaded.attendance[0].status).toBe("present");
  });

  test("cancelled / postponed classes past their time → untouched", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    const cancelled = await createClass({ tutor: teacher, students: [student], scheduledAt: stale(now), status: "cancelled" });
    const postponed = await createClass({ tutor: teacher, students: [student], scheduledAt: stale(now), status: "postponed" });

    const result = await runAutoCompleteClassesTick(now);
    expect(result.completed).toBe(0);
    expect((await Class.findById(cancelled._id)).status).toBe("cancelled");
    expect((await Class.findById(postponed._id)).status).toBe("postponed");
  });

  test("two concurrent ticks → the class is processed exactly once", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: stale(now) });

    const [a, b] = await Promise.all([runAutoCompleteClassesTick(now), runAutoCompleteClassesTick(now)]);
    expect(a.completed + b.completed).toBe(1);

    const reloaded = await Class.findById(cls._id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.attendance).toHaveLength(1); // not doubled
  });

  test("cutoff uses each class's own durationMinutes", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    const startedAt = new Date(now.getTime() - 80 * 60 * 1000);
    // 45-min class ended 35 min ago → past the 30-min grace.
    const shortCls = await createClass({ tutor: teacher, students: [student], scheduledAt: startedAt, durationMinutes: 45 });
    // 90-min class still has 10 min to run → nowhere near its grace period.
    const longCls = await createClass({ tutor: teacher, students: [student], scheduledAt: startedAt, durationMinutes: 90 });

    const result = await runAutoCompleteClassesTick(now);
    expect(result.completed).toBe(1);
    expect((await Class.findById(shortCls._id)).status).toBe("completed");
    expect((await Class.findById(longCls._id)).status).toBe("upcoming");
  });

  test("nothing stale → no writes, completed: 0", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    await createClass({ tutor: teacher, students: [student], scheduledAt: new Date(now.getTime() + 60 * 60 * 1000) });

    expect((await runAutoCompleteClassesTick(now)).completed).toBe(0);
  });
});

describe("End Class on a system-marked class — teacher's retroactive correction", () => {
  function endClass(teacher, classId, attendance) {
    return request(app)
      .patch(`/api/classes/${classId}/end`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ attendance });
  }

  test("tutor flips an auto-absent student to present: count increments once, record becomes teacher-owned, further edits rejected", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: stale(now) });

    await runAutoCompleteClassesTick(now);
    expect((await Class.findById(cls._id)).attendanceMarkedBy).toBe("system");

    const res = await endClass(teacher, cls._id, [{ studentId: student._id.toString(), status: "present" }]);
    expect(res.status).toBe(200);
    expect(res.body.class.attendanceMarkedBy).toBe("teacher");
    expect(res.body.class.attendance[0].status).toBe("present");
    expect((await User.findById(student._id)).completedClassCount).toBe(1);

    // A teacher-owned record is final — a second correction is a 409, no double-count.
    const again = await endClass(teacher, cls._id, [{ studentId: student._id.toString(), status: "present" }]);
    expect(again.status).toBe(409);
    expect((await User.findById(student._id)).completedClassCount).toBe(1);
  });

  test("two concurrent corrections on the same system record → exactly one 200 / one 409, count incremented once", async () => {
    const now = new Date();
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: stale(now) });
    await runAutoCompleteClassesTick(now);
    const attendance = [{ studentId: student._id.toString(), status: "present" }];

    const [a, b] = await Promise.all([endClass(teacher, cls._id, attendance), endClass(teacher, cls._id, attendance)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await User.findById(student._id)).completedClassCount).toBe(1);
  });

  test("a teacher who doesn't own the class still can't correct it → 403", async () => {
    const now = new Date();
    const owner = await createTeacher();
    const other = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({ tutor: owner, students: [student], scheduledAt: stale(now) });
    await runAutoCompleteClassesTick(now);

    const res = await endClass(other, cls._id, [{ studentId: student._id.toString(), status: "present" }]);
    expect(res.status).toBe(403);
    expect((await Class.findById(cls._id)).attendanceMarkedBy).toBe("system");
  });
});
