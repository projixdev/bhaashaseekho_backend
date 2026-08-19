// Phase 18: homework/assessment assigned, submitted, and reviewed — push +
// email fired from the existing endpoints, scoped via the same
// resolveAssignmentRecipients helper resolveClassRecipients' sibling uses.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, createAssignmentDoc, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));
const mockUploadBuffer = jest.fn().mockResolvedValue({ secure_url: "https://res.cloudinary.com/fake/mock.jpg" });
jest.unstable_mockModule("../src/config/cloudinary.js", () => ({ uploadBuffer: mockUploadBuffer }));

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { resolveAssignmentRecipients } = await import("../src/services/notificationScope.js");
const { sendTransactionalEmail } = await import("../src/services/brevoService.js");

beforeAll(connectTestDB);
afterEach(() => {
  jest.restoreAllMocks();
  sendTransactionalEmail.mockClear();
  mockUploadBuffer.mockClear();
  return clearTestDB();
});
afterAll(disconnectTestDB);

async function withPushToken(user, token) {
  await User.findByIdAndUpdate(user._id, { pushToken: token });
}

describe("resolveAssignmentRecipients — scoping", () => {
  test("an assignment with no matching active Enrollment resolves no recipients", async () => {
    const teacher = await createTeacher();
    const student = await createStudent(); // deliberately never enrolled with this teacher
    const assignment = await createAssignmentDoc({ student, tutor: teacher });

    const recipients = await resolveAssignmentRecipients(assignment._id);
    expect(recipients).toEqual({ tutor: null, student: null });
  });

  test("a properly enrolled pair resolves both tutor and student", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const assignment = await createAssignmentDoc({ student, tutor: teacher });

    const recipients = await resolveAssignmentRecipients(assignment._id);
    expect(recipients.tutor._id.toString()).toBe(teacher._id.toString());
    expect(recipients.student._id.toString()).toBe(student._id.toString());
  });
});

describe("POST /api/assignments — homework/assessment assigned", () => {
  test("student gets push + email; tutor does not", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await withPushToken(teacher, "tutor-token");
    await withPushToken(student, "student-token");

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ data: [] }) });

    const res = await request(app)
      .post("/api/assignments")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .field("studentId", student._id.toString())
      .field("type", "homework")
      .field("title", "Chapter 3 vocabulary");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pushedTokens = JSON.parse(fetchMock.mock.calls[0][1].body).map((m) => m.to);
    expect(pushedTokens).toEqual(["student-token"]);

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0][0].to).toBe(student.email);
  });

  test("no matching enrollment (route already 403s) → creation never happens, no notification", async () => {
    const teacher = await createTeacher();
    const otherTeacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: otherTeacher });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ data: [] }) });

    const res = await request(app)
      .post("/api/assignments")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .field("studentId", student._id.toString())
      .field("type", "homework")
      .field("title", "Should never be created");

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/assignments/:id/submit — uploaded by student", () => {
  test("tutor gets push + email; student does not", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const assignment = await createAssignmentDoc({ student, tutor: teacher, title: "Homework 1" });
    await withPushToken(teacher, "tutor-token");
    await withPushToken(student, "student-token");

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ data: [] }) });

    const res = await request(app)
      .post(`/api/assignments/${assignment._id}/submit`)
      .set("Authorization", `Bearer ${signToken(student)}`)
      .attach("file", Buffer.from("fake jpeg bytes"), { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pushedTokens = JSON.parse(fetchMock.mock.calls[0][1].body).map((m) => m.to);
    expect(pushedTokens).toEqual(["tutor-token"]);

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0][0].to).toBe(teacher.email);
  });
});

describe("PATCH /api/assignments/:id/review — reviewed/scored", () => {
  test("student gets push + email with the score", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    const assignment = await createAssignmentDoc({ student, tutor: teacher, title: "Homework 1" });
    await withPushToken(student, "student-token");

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ data: [] }) });

    const res = await request(app)
      .patch(`/api/assignments/${assignment._id}/review`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ score: "9/10" });

    expect(res.status).toBe(200);
    const pushedBody = JSON.parse(fetchMock.mock.calls[0][1].body)[0];
    expect(pushedBody.to).toBe("student-token");
    expect(pushedBody.body).toMatch(/9\/10/);

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0][0].to).toBe(student.email);
  });
});
