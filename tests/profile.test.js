// PATCH /api/profile — editable name/email for the app's Profile screen.
// Phone is deliberately not accepted (it's the OTP login identifier).
// Also POST /api/profile/deletion-request (Apple Guideline 5.1.1(v)).
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { sendTransactionalEmail } = await import("../src/services/brevoService.js");

beforeAll(connectTestDB);
afterEach(() => {
  sendTransactionalEmail.mockClear();
  return clearTestDB();
});
afterAll(disconnectTestDB);

function patchProfile(user, body) {
  return request(app).patch("/api/profile").set("Authorization", `Bearer ${signToken(user)}`).send(body);
}

function requestDeletion(user) {
  return request(app).post("/api/profile/deletion-request").set("Authorization", `Bearer ${signToken(user)}`).send();
}

test("updates name and email, returns the same shape as login", async () => {
  const student = await createStudent({ name: "Old Name" });

  const res = await patchProfile(student, { name: "  New Name  ", email: "New@Example.com" });

  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({
    id: student._id.toString(),
    name: "New Name",
    email: "new@example.com",
  });
  const stored = await User.findById(student._id);
  expect(stored.name).toBe("New Name");
  expect(stored.email).toBe("new@example.com");
});

test("updates only the field provided — omitting email leaves it untouched", async () => {
  const student = await createStudent({ name: "Original", email: "original@example.com" });

  const res = await patchProfile(student, { name: "Updated" });

  expect(res.status).toBe(200);
  expect(res.body.user.email).toBe("original@example.com");
});

test("empty name → 400", async () => {
  const student = await createStudent();
  const res = await patchProfile(student, { name: "   " });
  expect(res.status).toBe(400);
});

test("invalid email format → 400", async () => {
  const student = await createStudent();
  const res = await patchProfile(student, { email: "not-an-email" });
  expect(res.status).toBe(400);
});

test("email already used by another account → 409, nothing changed", async () => {
  await createStudent({ email: "taken@example.com" });
  const student = await createStudent({ email: "mine@example.com" });

  const res = await patchProfile(student, { email: "taken@example.com" });

  expect(res.status).toBe(409);
  expect((await User.findById(student._id)).email).toBe("mine@example.com");
});

test("no fields given → 400", async () => {
  const student = await createStudent();
  const res = await patchProfile(student, {});
  expect(res.status).toBe(400);
});

test("phone in the body is ignored, not applied", async () => {
  const teacher = await createTeacher();
  const originalPhone = teacher.phone;

  await patchProfile(teacher, { name: "New Name", phone: "9000000000" });

  expect((await User.findById(teacher._id)).phone).toBe(originalPhone);
});

test("no token → 401", async () => {
  const res = await request(app).patch("/api/profile").send({ name: "Hi" });
  expect(res.status).toBe(401);
});

test("accessExpiresAt reflects trial state — null for a permanent student, the real expiry for a trial student", async () => {
  const permanent = await createStudent();
  const permanentRes = await patchProfile(permanent, { name: "Still Permanent" });
  expect(permanentRes.body.user.accessExpiresAt).toBeNull();

  const expiry = new Date(Date.now() + 60 * 60 * 1000);
  const trial = await createStudent({ isTrial: true, accessExpiresAt: expiry });
  const trialRes = await patchProfile(trial, { name: "Still Trial" });
  expect(trialRes.body.user.accessExpiresAt).toBe(expiry.toISOString());
});

describe("POST /api/profile/deletion-request", () => {
  test("deactivates the account, kills the session, notifies the team", async () => {
    const student = await createStudent({ name: "Leaving User", email: "leaving@example.com" });
    await User.findByIdAndUpdate(student._id, { activeSessionId: "sess-123", pushToken: "ExponentPushToken[x]" });

    const res = await requestDeletion(student);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const stored = await User.findById(student._id).select("+activeSessionId");
    expect(stored.deletionRequestedAt).toBeInstanceOf(Date);
    expect(stored.isActive).toBe(false);
    expect(stored.activeSessionId).toBeNull();
    expect(stored.pushToken).toBeNull();

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    const mail = sendTransactionalEmail.mock.calls[0][0];
    expect(mail.subject).toContain("Leaving User");
    expect(mail.htmlContent).toContain(student._id.toString());
  });

  test("idempotent — a repeat request succeeds without firing a second team email", async () => {
    const student = await createStudent();

    const first = await requestDeletion(student);
    const second = await requestDeletion(student);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  test("no token → 401", async () => {
    const res = await request(app).post("/api/profile/deletion-request").send();
    expect(res.status).toBe(401);
  });
});
