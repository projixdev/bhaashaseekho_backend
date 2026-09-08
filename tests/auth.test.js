// send-otp / verify-otp functional behavior. Every request below sets a
// unique X-Forwarded-For so this file's tests never share a rate-limit
// bucket with each other — that's covered on purpose, in isolation, by
// rateLimit.test.js instead. Wrong/expired-OTP tests seed otpHash directly
// with the real hashOtp()/generateOtp() utilities rather than calling
// send-otp, so they don't need a real code round-trip to set up state.
import { jest } from "@jest/globals";
import request from "supertest";
import jwt from "jsonwebtoken";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, nextIp } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({ messageId: "mock" }),
}));

const { default: app } = await import("../src/app.js");
const { sendTransactionalEmail } = await import("../src/services/brevoService.js");
const { default: User } = await import("../src/models/User.js");
const { generateOtp, hashOtp } = await import("../src/utils/otp.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function sendOtp(phone) {
  return request(app).post("/api/auth/send-otp").set("X-Forwarded-For", nextIp()).send({ phone });
}

function verifyOtp(phone, otp) {
  return request(app).post("/api/auth/verify-otp").set("X-Forwarded-For", nextIp()).send({ phone, otp });
}

describe("send-otp", () => {
  test("unenrolled phone number → 404, unchanged message (Phase 1's signup hole must never reopen)", async () => {
    const res = await sendOtp("9999999999");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("This number isn't enrolled yet. Please enroll on our website first.");
    // Confirms sendOtp truly never creates a User for an unknown number.
    expect(await User.findOne({ phone: "9999999999" })).toBeNull();
  });

  test("enrolled number with no email → 400", async () => {
    const student = await createStudent({ email: null });
    const res = await sendOtp(student.phone);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("No email on file — contact admin to add one.");
  });

  test("enrolled number with email → 200, OTP generated and emailed (Brevo mocked)", async () => {
    const student = await createStudent({ email: "real@example.com" });
    const res = await sendOtp(student.phone);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0][0].to).toBe("real@example.com");

    const stored = await User.findById(student._id);
    expect(stored.otpHash).toBeTruthy();
    expect(stored.otpExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("response includes the masked email the code was sent to (login-screen copy), never the raw address", async () => {
    const student = await createStudent({ email: "vijaykalyan3081@gmail.com" });
    const res = await sendOtp(student.phone);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("v***@gmail.com");
    expect(JSON.stringify(res.body)).not.toContain("vijaykalyan3081");
  });
});

describe("verify-otp", () => {
  test("correct OTP → 200, JWT carries the right role and identity", async () => {
    const teacher = await createTeacher();
    const sent = await sendOtp(teacher.phone);
    expect(sent.status).toBe(200);
    expect(sent.body.devOtp).toMatch(/^\d{6}$/);

    const res = await verifyOtp(teacher.phone, sent.body.devOtp);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.role).toBe("teacher");
    expect(res.body.user.id).toBe(teacher._id.toString());

    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(decoded.role).toBe("teacher");
    expect(decoded.sub).toBe(teacher._id.toString());
  });

  test("accessExpiresAt reflects trial state — null for a permanent student, the real expiry for a trial student", async () => {
    const permanent = await createStudent();
    const sentPermanent = await sendOtp(permanent.phone);
    const permanentRes = await verifyOtp(permanent.phone, sentPermanent.body.devOtp);
    expect(permanentRes.body.user.accessExpiresAt).toBeNull();

    const expiry = new Date(Date.now() + 60 * 60 * 1000);
    const trial = await createStudent({ isTrial: true, accessExpiresAt: expiry });
    const sentTrial = await sendOtp(trial.phone);
    const trialRes = await verifyOtp(trial.phone, sentTrial.body.devOtp);
    expect(trialRes.body.user.accessExpiresAt).toBe(expiry.toISOString());
  });

  test("wrong OTP → rejected, 400", async () => {
    const student = await createStudent();
    const correctOtp = generateOtp();
    student.otpHash = hashOtp(student.phone, correctOtp);
    student.otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await student.save();

    const wrongOtp = correctOtp === "000000" ? "111111" : "000000";
    const res = await verifyOtp(student.phone, wrongOtp);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Incorrect code.");
  });

  test("expired OTP → rejected, 400", async () => {
    const student = await createStudent();
    const otp = generateOtp();
    student.otpHash = hashOtp(student.phone, otp);
    student.otpExpiresAt = new Date(Date.now() - 1000); // already in the past
    await student.save();

    const res = await verifyOtp(student.phone, otp);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Code expired. Request a new one.");
  });

  test("no OTP ever requested → 400, distinct message", async () => {
    const student = await createStudent();
    const res = await verifyOtp(student.phone, "123456");
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Request a new code first.");
  });
});

describe("reviewer bypass (Play Store review)", () => {
  const REVIEWER_PHONE = "9812345670";
  const REVIEWER_OTP = "482913";
  let originalPhone, originalOtp;

  beforeAll(() => {
    originalPhone = process.env.REVIEWER_TEST_PHONE;
    originalOtp = process.env.REVIEWER_TEST_OTP;
    process.env.REVIEWER_TEST_PHONE = REVIEWER_PHONE;
    process.env.REVIEWER_TEST_OTP = REVIEWER_OTP;
  });

  afterAll(() => {
    if (originalPhone === undefined) delete process.env.REVIEWER_TEST_PHONE;
    else process.env.REVIEWER_TEST_PHONE = originalPhone;
    if (originalOtp === undefined) delete process.env.REVIEWER_TEST_OTP;
    else process.env.REVIEWER_TEST_OTP = originalOtp;
  });

  test("configured phone + configured OTP → 200, valid session, no email ever attempted", async () => {
    await createStudent({ phone: REVIEWER_PHONE, name: "Play Store Reviewer", email: "reviewer@bhaashaseekho.com" });

    const callsBefore = sendTransactionalEmail.mock.calls.length;
    const sent = await sendOtp(REVIEWER_PHONE);
    expect(sent.status).toBe(200);
    expect(sendTransactionalEmail.mock.calls.length).toBe(callsBefore); // unchanged -- no email attempt

    const res = await verifyOtp(REVIEWER_PHONE, REVIEWER_OTP);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.phone).toBe(REVIEWER_PHONE);
    expect(res.body.user.role).toBe("student");

    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(decoded.sub).toBe(res.body.user.id);
  });

  test("configured phone + wrong OTP → still fails, not a blanket pass for the phone alone", async () => {
    await createStudent({ phone: REVIEWER_PHONE });

    const res = await verifyOtp(REVIEWER_PHONE, "111111");
    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
  });

  test("a real user's own login is unaffected by the reviewer bypass being configured", async () => {
    const student = await createStudent();
    const sent = await sendOtp(student.phone);
    expect(sent.status).toBe(200);
    expect(sendTransactionalEmail).toHaveBeenCalled();

    const res = await verifyOtp(student.phone, sent.body.devOtp);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(student._id.toString());
  });
});

describe("reviewer bypass — multiple phones sharing one OTP (Play Store student demo + App Store teacher demo)", () => {
  const STUDENT_PHONE = "9812345671";
  const TEACHER_PHONE = "9812345672";
  const SHARED_OTP = "482913";
  let originalPhone, originalOtp;

  beforeAll(() => {
    originalPhone = process.env.REVIEWER_TEST_PHONE;
    originalOtp = process.env.REVIEWER_TEST_OTP;
    process.env.REVIEWER_TEST_PHONE = `${STUDENT_PHONE},${TEACHER_PHONE}`;
    process.env.REVIEWER_TEST_OTP = SHARED_OTP;
  });

  afterAll(() => {
    if (originalPhone === undefined) delete process.env.REVIEWER_TEST_PHONE;
    else process.env.REVIEWER_TEST_PHONE = originalPhone;
    if (originalOtp === undefined) delete process.env.REVIEWER_TEST_OTP;
    else process.env.REVIEWER_TEST_OTP = originalOtp;
  });

  test("both configured phones sign in with the same shared OTP, each keeping their own real role", async () => {
    await createStudent({ phone: STUDENT_PHONE, name: "Play Store Reviewer" });
    await createTeacher({ phone: TEACHER_PHONE, name: "Apple Teacher Testing" });

    const studentRes = await verifyOtp(STUDENT_PHONE, SHARED_OTP);
    expect(studentRes.status).toBe(200);
    expect(studentRes.body.user.role).toBe("student");
    expect(studentRes.body.user.phone).toBe(STUDENT_PHONE);

    const teacherRes = await verifyOtp(TEACHER_PHONE, SHARED_OTP);
    expect(teacherRes.status).toBe(200);
    expect(teacherRes.body.user.role).toBe("teacher");
    expect(teacherRes.body.user.phone).toBe(TEACHER_PHONE);
  });

  test("a phone not in the configured list never gets the bypass, even with the correct shared OTP", async () => {
    const other = await createStudent();
    const res = await verifyOtp(other.phone, SHARED_OTP);
    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
  });
});
