// Dedicated file, deliberately isolated from auth.test.js: the rate limiter
// (middleware/rateLimit.js) and the per-user otpAttempts exhaustion check
// (utils/otp.js MAX_OTP_ATTEMPTS, still 5) sit on the exact same verify-otp
// route. Tested from one fixed IP, the rate limiter always fires first — so
// this file reuses one IP on purpose to prove the limiter itself works,
// while roleIsolation/auth tests deliberately vary IP per call to avoid
// tripping it by accident. otpAttempts exhaustion (a distinct, per-user
// control that still matters against an attacker spread across many IPs) is
// covered separately below by varying the IP so the limiter never masks it.
//
// auth-send-otp/auth-verify-otp carry no per-route override any more (the
// closed-testing 15/10min bump was reverted with the testing period), so the
// two tests below assert against rateLimit's own 5/10min default — the same
// threshold every other rate-limited route uses.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, nextIp } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { generateOtp, hashOtp } = await import("../src/utils/otp.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

// A different account per request, one fixed IP. The per-IP bucket is what's
// under test here; reusing a single phone would instead trip sendOtp's
// per-account 60s resend cooldown (covered in auth.test.js) on the second
// call and never reach the IP limit at all. Varying the phone also proves the
// bucket really is keyed per-IP rather than per-phone.
test("auth-send-otp: 6th request from the same IP within the window → 429", async () => {
  const ip = nextIp();

  for (let i = 0; i < 5; i++) {
    const student = await createStudent();
    const res = await request(app).post("/api/auth/send-otp").set("X-Forwarded-For", ip).send({ phone: student.phone });
    expect(res.status).not.toBe(429);
  }

  const extra = await createStudent();
  const blocked = await request(app).post("/api/auth/send-otp").set("X-Forwarded-For", ip).send({ phone: extra.phone });
  expect(blocked.status).toBe(429);
  expect(blocked.body.message).toBe("Too many requests. Please try again later.");
});

test("auth-verify-otp: 6th request from the same IP within the window → 429", async () => {
  const ip = nextIp();

  for (let i = 0; i < 5; i++) {
    const res = await request(app)
      .post("/api/auth/verify-otp")
      .set("X-Forwarded-For", ip)
      .send({ phone: "9700000000", otp: "000000" });
    expect(res.status).not.toBe(429);
  }

  const blocked = await request(app)
    .post("/api/auth/verify-otp")
    .set("X-Forwarded-For", ip)
    .send({ phone: "9700000000", otp: "000000" });
  expect(blocked.status).toBe(429);
  expect(blocked.body.message).toBe("Too many requests. Please try again later.");
});

test("otpAttempts exhaustion (MAX_OTP_ATTEMPTS=5) still fires on its own when requests come from different IPs", async () => {
  const student = await createStudent();
  const correctOtp = generateOtp();
  student.otpHash = hashOtp(student.phone, correctOtp);
  student.otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await student.save();
  const wrongOtp = correctOtp === "000000" ? "111111" : "000000";

  for (let i = 0; i < 5; i++) {
    const res = await request(app)
      .post("/api/auth/verify-otp")
      .set("X-Forwarded-For", nextIp())
      .send({ phone: student.phone, otp: wrongOtp });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Incorrect code.");
  }

  const exhausted = await request(app)
    .post("/api/auth/verify-otp")
    .set("X-Forwarded-For", nextIp())
    .send({ phone: student.phone, otp: wrongOtp });
  expect(exhausted.status).toBe(429);
  expect(exhausted.body.message).toBe("Too many attempts. Request a new code.");
});
