// Trial/demo accounts: admin creates the account directly (dashboard's
// Trial/Permanent dropdown — see adminCrud.test.js for that path), this
// file covers expiry gating on send-otp and requireAuth regardless of how
// the trial got created. Every send-otp/verify-otp call below uses a unique
// IP (see auth.test.js's own comment) so this file's tests don't share a
// rate-limit bucket by accident.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, signToken, nextIp } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function sendOtp(phone) {
  return request(app).post("/api/auth/send-otp").set("X-Forwarded-For", nextIp()).send({ phone });
}

describe("send-otp — trial expiry", () => {
  test("trial user before expiry → send-otp succeeds normally", async () => {
    const student = await createStudent({
      isTrial: true,
      accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    });
    const res = await sendOtp(student.phone);
    expect(res.status).toBe(200);
    expect(res.body.devOtp).toMatch(/^\d{6}$/);
  });

  test("trial user past accessExpiresAt → distinct 403, not the generic unenrolled message", async () => {
    const student = await createStudent({
      isTrial: true,
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    const res = await sendOtp(student.phone);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Your trial access has expired.");
  });

  test("non-trial user is completely unaffected — regression", async () => {
    const student = await createStudent();
    const res = await sendOtp(student.phone);
    expect(res.status).toBe(200);
    expect(res.body.devOtp).toMatch(/^\d{6}$/);
  });

  test("unenrolled number still 404s with the unchanged message — this phase must not touch that path", async () => {
    const res = await sendOtp("9999999998");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("This number isn't enrolled yet. Please enroll on our website first.");
  });
});

describe("requireAuth — trial expiry", () => {
  test("expired trial JWT on a protected route → 403, distinct message", async () => {
    const student = await createStudent({
      isTrial: true,
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Your trial access has expired.");
  });

  test("not-yet-expired trial JWT on a protected route → passes through normally", async () => {
    const student = await createStudent({
      isTrial: true,
      accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${signToken(student)}`);
    expect(res.status).toBe(200);
  });

  test("a non-trial teacher's token is unaffected — regression", async () => {
    const teacher = await createTeacher();
    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(200);
  });
});
