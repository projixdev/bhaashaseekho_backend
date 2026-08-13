// GET /api/classes and GET /api/assignments are shared routes (see the
// Phase 12 kickoff explanation: no literal "student-only" route exists) —
// both roles hit the same endpoint and get role-branched, ownership-scoped
// data back rather than a 403. This file proves the scoping itself, plus the
// assessment gate (countPastClasses in assignmentController.js), which is
// separate business logic from the role/ownership checks in roleIsolation.test.js.
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
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

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

  test("assessment gate: 9 past classes → locked and omitted; 10 → unlocked and returned", async () => {
    const teacher = await createTeacher();
    const lockedStudent = await createStudent();
    const unlockedStudent = await createStudent();

    for (let i = 0; i < 9; i++) {
      await createClass({ tutor: teacher, students: [lockedStudent], scheduledAt: daysAgo(i + 1) });
    }
    for (let i = 0; i < 10; i++) {
      await createClass({ tutor: teacher, students: [unlockedStudent], scheduledAt: daysAgo(i + 1) });
    }
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
