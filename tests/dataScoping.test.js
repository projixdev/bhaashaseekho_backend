// GET /api/classes and GET /api/assignments are shared routes (see the
// Phase 12 kickoff explanation: no literal "student-only" route exists) —
// both roles hit the same endpoint and get role-branched, ownership-scoped
// data back rather than a 403. This file proves the scoping itself, plus the
// assessment gate (User.completedClassCount, ROADMAP.md Phase 13), which is
// separate business logic from the role/ownership checks in roleIsolation.test.js.
// The gate itself is driven purely by completedClassCount, written by
// classController.endClass — see endClass.test.js for how that count gets
// there; this file seeds it directly since the gate threshold is what's
// under test here, not the End Class flow.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createClass, createAssignmentDoc, signToken } from "./helpers/fixtures.js";

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

const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

describe("GET /api/classes scoping", () => {
  test("student sees only their own class; teacher sees only classes they teach; unrelated party's class never leaks", async () => {
    const teacherA = await createTeacher();
    const teacherB = await createTeacher();
    const studentA = await createStudent();
    const studentB = await createStudent();
    const classA = await createClass({ tutor: teacherA, students: [studentA], scheduledAt: inOneDay() });
    const classB = await createClass({ tutor: teacherB, students: [studentB], scheduledAt: inOneDay() });

    const asStudentA = await request(app).get("/api/classes").set("Authorization", `Bearer ${signToken(studentA)}`);
    expect(asStudentA.body.classes.map((c) => c._id)).toEqual([classA._id.toString()]);

    const asTeacherA = await request(app).get("/api/classes").set("Authorization", `Bearer ${signToken(teacherA)}`);
    expect(asTeacherA.body.classes.map((c) => c._id)).toEqual([classA._id.toString()]);

    const asTeacherB = await request(app).get("/api/classes").set("Authorization", `Bearer ${signToken(teacherB)}`);
    expect(asTeacherB.body.classes.map((c) => c._id)).toEqual([classB._id.toString()]);
  });
});

describe("GET /api/classes?from=&to= — date-range view for the app's week calendar (Phase 19 Part 3)", () => {
  test("returns classes of every status inside the range, unlike the default upcoming/live-only view", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const rangeStart = new Date("2026-09-07T00:00:00.000Z"); // a Monday
    const rangeEnd = new Date("2026-09-14T00:00:00.000Z"); // the following Monday

    const completedInRange = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date("2026-09-08T12:00:00.000Z"),
      attendance: [{ studentId: student._id.toString(), status: "present" }],
    });
    const cancelledInRange = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date("2026-09-10T12:00:00.000Z"),
      status: "cancelled",
    });
    const upcomingInRange = await createClass({
      tutor: teacher,
      students: [student],
      scheduledAt: new Date("2026-09-12T12:00:00.000Z"),
    });
    await createClass({ tutor: teacher, students: [student], scheduledAt: new Date("2026-09-20T12:00:00.000Z") }); // outside the range

    const res = await request(app)
      .get(`/api/classes?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(200);
    expect(res.body.classes.map((c) => c._id).sort()).toEqual(
      [completedInRange._id.toString(), cancelledInRange._id.toString(), upcomingInRange._id.toString()].sort()
    );
  });

  test("scoping still applies — a date-ranged request never returns another teacher's class", async () => {
    const teacherA = await createTeacher();
    const teacherB = await createTeacher();
    const student = await createStudent();
    const rangeStart = new Date("2026-09-07T00:00:00.000Z");
    const rangeEnd = new Date("2026-09-14T00:00:00.000Z");
    await createClass({ tutor: teacherB, students: [student], scheduledAt: new Date("2026-09-08T12:00:00.000Z") });

    const res = await request(app)
      .get(`/api/classes?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`)
      .set("Authorization", `Bearer ${signToken(teacherA)}`);

    expect(res.body.classes).toEqual([]);
  });

  test("invalid from/to → 400", async () => {
    const teacher = await createTeacher();
    const res = await request(app)
      .get("/api/classes?from=not-a-date&to=also-not-a-date")
      .set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(400);
  });

  test("only one of from/to given → falls back to the default upcoming/live view, not an error", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass({ tutor: teacher, students: [student], scheduledAt: inOneDay() });

    const res = await request(app)
      .get(`/api/classes?from=${new Date().toISOString()}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(200);
    expect(res.body.classes.map((c) => c._id)).toEqual([cls._id.toString()]);
  });
});

describe("GET /api/assignments scoping", () => {
  test("teacher sees only assignments they created; student sees only their own homework", async () => {
    const teacherA = await createTeacher();
    const teacherB = await createTeacher();
    const studentA = await createStudent();
    const studentB = await createStudent();
    const assignmentA = await createAssignmentDoc({ student: studentA, tutor: teacherA, title: "For A" });
    await createAssignmentDoc({ student: studentB, tutor: teacherB, title: "For B" });

    const asTeacherA = await request(app).get("/api/assignments").set("Authorization", `Bearer ${signToken(teacherA)}`);
    expect(asTeacherA.body.assignments).toHaveLength(1);
    expect(asTeacherA.body.assignments[0]._id).toBe(assignmentA._id.toString());

    const asStudentA = await request(app).get("/api/assignments").set("Authorization", `Bearer ${signToken(studentA)}`);
    expect(asStudentA.body.homework).toHaveLength(1);
    expect(asStudentA.body.homework[0]._id).toBe(assignmentA._id.toString());
  });

  test("assessment gate: completedClassCount 9 → locked and omitted; 10 → unlocked and returned", async () => {
    const teacher = await createTeacher();
    const lockedStudent = await createStudent({ completedClassCount: 9 });
    const unlockedStudent = await createStudent({ completedClassCount: 10 });

    await createAssignmentDoc({ student: lockedStudent, tutor: teacher, type: "assessment", title: "Assessment" });
    await createAssignmentDoc({ student: lockedStudent, tutor: teacher, type: "homework", title: "Homework" });
    await createAssignmentDoc({ student: unlockedStudent, tutor: teacher, type: "assessment", title: "Assessment" });

    const locked = await request(app).get("/api/assignments").set("Authorization", `Bearer ${signToken(lockedStudent)}`);
    expect(locked.body.classesCompleted).toBe(9);
    expect(locked.body.assessmentsUnlocked).toBe(false);
    expect(locked.body.assessments).toEqual([]);
    expect(locked.body.homework).toHaveLength(1); // homework is never gated

    const unlocked = await request(app).get("/api/assignments").set("Authorization", `Bearer ${signToken(unlockedStudent)}`);
    expect(unlocked.body.classesCompleted).toBe(10);
    expect(unlocked.body.assessmentsUnlocked).toBe(true);
    expect(unlocked.body.assessments).toHaveLength(1);
  });
});
