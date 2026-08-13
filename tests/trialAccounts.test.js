// Trial/demo accounts (ROADMAP.md Phase 14): the website's trial-booking
// flow (POST /api/leads with trialClassAt) as a second, rate-limited way a
// User gets created, plus expiry gating on send-otp and requireAuth. Every
// leads/send-otp/verify-otp call below uses a unique IP (see auth.test.js's
// own comment) so this file's tests don't share a rate-limit bucket by accident.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, signToken, nextIp } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function sendOtp(phone) {
  return request(app).post("/api/auth/send-otp").set("X-Forwarded-For", nextIp()).send({ phone });
}

function postLead(body) {
  return request(app).post("/api/leads").set("X-Forwarded-For", nextIp()).send(body);
}

const validLeadBody = (overrides = {}) => ({
  name: "Trial Visitor",
  phone: "9800000001",
  interest: "Kannada",
  ...overrides,
});

describe("POST /api/leads — trial booking", () => {
  test("trialClassAt creates a User with correct isTrial/accessExpiresAt/email", async () => {
    const trialClassAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days out
    const res = await postLead(validLeadBody({ email: "trial@example.com", trialClassAt: trialClassAt.toISOString() }));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const user = await User.findOne({ phone: "9800000001" });
    expect(user).not.toBeNull();
    expect(user.role).toBe("student");
    expect(user.isTrial).toBe(true);
    expect(user.email).toBe("trial@example.com");
    expect(user.accessExpiresAt.getTime()).toBe(trialClassAt.getTime() + 24 * 60 * 60 * 1000);
  });

  test("a regular lead (no trialClassAt) never creates a User — regression", async () => {
    const res = await postLead(validLeadBody({ phone: "9800000002" }));
    expect(res.status).toBe(200);
    expect(await User.findOne({ phone: "9800000002" })).toBeNull();
  });

  test("trialClassAt without email → 400", async () => {
    const res = await postLead(validLeadBody({ phone: "9800000003", trialClassAt: new Date().toISOString() }));
    expect(res.status).toBe(400);
    expect(await User.findOne({ phone: "9800000003" })).toBeNull();
  });

  test("trialClassAt with an invalid phone → 400", async () => {
    const res = await postLead(
      validLeadBody({ phone: "123", email: "trial@example.com", trialClassAt: new Date().toISOString() })
    );
    expect(res.status).toBe(400);
  });

  test("malformed trialClassAt → 400", async () => {
    const res = await postLead(
      validLeadBody({ phone: "9800000004", email: "trial@example.com", trialClassAt: "not-a-date" })
    );
    expect(res.status).toBe(400);
    expect(await User.findOne({ phone: "9800000004" })).toBeNull();
  });

  test("re-booking the same phone refreshes accessExpiresAt on the existing trial user", async () => {
    const first = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
    const firstRes = await postLead(
      validLeadBody({ phone: "9800000005", email: "trial@example.com", trialClassAt: first.toISOString() })
    );
    expect(firstRes.status).toBe(200);

    const second = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const secondRes = await postLead(
      validLeadBody({ phone: "9800000005", email: "trial@example.com", trialClassAt: second.toISOString() })
    );
    expect(secondRes.status).toBe(200);

    const users = await User.find({ phone: "9800000005" });
    expect(users).toHaveLength(1);
    expect(users[0].accessExpiresAt.getTime()).toBe(second.getTime() + 24 * 60 * 60 * 1000);
  });

  test("never downgrades an existing non-trial account with the same phone", async () => {
    const realStudent = await createStudent({ phone: "9800000006", isTrial: false });

    const res = await postLead(
      validLeadBody({ phone: "9800000006", email: "someone-else@example.com", trialClassAt: new Date().toISOString() })
    );
    expect(res.status).toBe(200); // the lead itself still saves fine

    const reloaded = await User.findById(realStudent._id);
    expect(reloaded.isTrial).toBe(false);
    expect(reloaded.accessExpiresAt).toBeNull();
    expect(reloaded.email).toBe(realStudent.email); // untouched, not overwritten
  });
});

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
