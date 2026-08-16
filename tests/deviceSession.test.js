// Single-device login enforcement + forced monthly re-login for teachers
// and students (deliberately not the separate admin password-login token —
// see requireAuth.js's own comment on that). Uses the real send-otp/
// verify-otp round trip rather than the signToken() fixture shortcut for
// the single-device tests, since the whole point is proving the actual
// sessionId issued by a real login is what gets checked — a fixture-signed
// token has no sessionId at all and is deliberately exempt (see below).
import { jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createAdminUser, signToken, signAdminToken, nextIp } from "./helpers/fixtures.js";

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

function verifyOtp(phone, otp, extra = {}) {
  return request(app).post("/api/auth/verify-otp").set("X-Forwarded-For", nextIp()).send({ phone, otp, ...extra });
}

async function realLogin(phone, extra = {}) {
  const sent = await sendOtp(phone);
  return verifyOtp(phone, sent.body.devOtp, extra);
}

describe("single-device login", () => {
  test("first-ever login for an account → succeeds directly, no conflict", async () => {
    const student = await createStudent();
    const res = await realLogin(student.phone);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });

  test("second device logging in without forceLogout → 409, first device's session untouched", async () => {
    const student = await createStudent();
    const first = await realLogin(student.phone);
    expect(first.status).toBe(200);

    const second = await realLogin(student.phone);
    expect(second.status).toBe(409);
    expect(second.body.requiresForceLogout).toBe(true);
    expect(second.body.token).toBeUndefined();

    // First device's token still works — nothing changed server-side yet.
    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${first.body.token}`);
    expect(res.status).toBe(200);
  });

  test("second device with forceLogout: true → succeeds, and invalidates the first device's token", async () => {
    const student = await createStudent();
    const first = await realLogin(student.phone);
    expect(first.status).toBe(200);

    const second = await realLogin(student.phone, { forceLogout: true });
    expect(second.status).toBe(200);
    expect(typeof second.body.token).toBe("string");
    expect(second.body.token).not.toBe(first.body.token);

    // First device's now-superseded token is rejected with the specific
    // "logged in elsewhere" message, not a generic auth failure.
    const staleRes = await request(app).get("/api/classes").set("Authorization", `Bearer ${first.body.token}`);
    expect(staleRes.status).toBe(401);
    expect(staleRes.body.message).toBe("You've been logged out because this account was signed in on another device.");

    // Second device's fresh token works normally.
    const freshRes = await request(app).get("/api/classes").set("Authorization", `Bearer ${second.body.token}`);
    expect(freshRes.status).toBe(200);
  });

  test("the conflicting OTP isn't consumed by the 409 — the same code works for the forceLogout retry", async () => {
    const student = await createStudent();
    const first = await realLogin(student.phone);
    expect(first.status).toBe(200);

    const sent = await sendOtp(student.phone);
    const conflict = await verifyOtp(student.phone, sent.body.devOtp);
    expect(conflict.status).toBe(409);

    // Same code, no new send-otp call, now with forceLogout.
    const confirmed = await verifyOtp(student.phone, sent.body.devOtp, { forceLogout: true });
    expect(confirmed.status).toBe(200);
  });

  test("a fixture-signed token (no sessionId claim — predates any real login) is exempt, not rejected", async () => {
    const teacher = await createTeacher();
    const res = await request(app).get("/api/roster").set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(res.status).toBe(200);
  });

  test("admin password-login token needs no sessionId/loginMonth and is unaffected by this feature", async () => {
    const { user: admin } = await createAdminUser();
    const res = await request(app).get("/api/admin/teachers").set("Authorization", `Bearer ${signAdminToken(admin)}`);
    expect(res.status).toBe(200);
  });
});

describe("forced monthly re-login", () => {
  function tokenWithLoginMonth(user, loginMonth) {
    return jwt.sign(
      { sub: user._id.toString(), phone: user.phone, role: user.role, isAdmin: Boolean(user.isAdmin), loginMonth },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
  }

  test("a token whose loginMonth doesn't match the current month → 401, distinct message", async () => {
    const student = await createStudent();
    const staleToken = tokenWithLoginMonth(student, "2000-01");

    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${staleToken}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Your monthly session has expired. Please log in again.");
  });

  test("a real login's token carries the current month and passes through normally", async () => {
    const student = await createStudent();
    const login = await realLogin(student.phone);
    expect(login.status).toBe(200);

    const decoded = jwt.decode(login.body.token);
    const now = new Date();
    const expectedMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(decoded.loginMonth).toBe(expectedMonth);

    const res = await request(app).get("/api/classes").set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });
});
