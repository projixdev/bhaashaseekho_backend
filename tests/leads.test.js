// POST /api/leads — the public website's lead-capture form, and (Phase 22
// course discovery) the app's authenticated "Request this course" flow
// reusing the same endpoint via optionalAuth. No prior test file covered
// this endpoint at all before this phase.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, signToken, nextIp } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { default: Lead } = await import("../src/models/Lead.js");
const { sendTransactionalEmail } = await import("../src/services/brevoService.js");

beforeAll(connectTestDB);
afterEach(() => {
  sendTransactionalEmail.mockClear();
  return clearTestDB();
});
afterAll(disconnectTestDB);

test("public submission (no token) → 200, lead saved, owner + visitor confirmation emails sent", async () => {
  const res = await request(app)
    .post("/api/leads")
    .set("X-Forwarded-For", nextIp())
    .send({ name: "Asha", phone: "9876543210", email: "asha@example.com", interest: "Kannada" });

  expect(res.status).toBe(200);
  const lead = await Lead.findOne({ name: "Asha" });
  expect(lead).not.toBeNull();
  expect(lead.courseSlug).toBe("");
  expect(lead.userId).toBeNull();

  expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
  const [ownerCall, confirmCall] = sendTransactionalEmail.mock.calls.map((c) => c[0]);
  expect(ownerCall.to).toBe("owner@example.com"); // tests/setupEnv.js's CLIENT_NOTIFICATION_EMAIL
  expect(confirmCall.to).toBe("asha@example.com");
  expect(confirmCall.subject).toContain("demo login");
});

test("missing required fields → 400, nothing saved", async () => {
  const res = await request(app)
    .post("/api/leads")
    .set("X-Forwarded-For", nextIp())
    .send({ name: "", phone: "", interest: "" });

  expect(res.status).toBe(400);
  expect(res.body.errors).toBeTruthy();
  expect(await Lead.countDocuments()).toBe(0);
});

test("honeypot filled → pretends success, nothing saved, no email sent", async () => {
  const res = await request(app)
    .post("/api/leads")
    .set("X-Forwarded-For", nextIp())
    .send({ name: "Bot", phone: "9876543210", interest: "Kannada", honeypot: "I am a bot" });

  expect(res.status).toBe(200);
  expect(await Lead.countDocuments()).toBe(0);
  expect(sendTransactionalEmail).not.toHaveBeenCalled();
});

test("authenticated app submission with a valid courseSlug → lead carries userId + courseSlug, no demo-login email", async () => {
  const student = await createStudent({ name: "Priya", email: "priya@example.com" });

  const res = await request(app)
    .post("/api/leads")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .set("X-Forwarded-For", nextIp())
    .send({
      name: "Priya",
      phone: student.phone,
      email: "priya@example.com",
      interest: "Hindi — Reading & Writing",
      courseSlug: "hindi-reading-writing",
    });

  expect(res.status).toBe(200);
  const lead = await Lead.findOne({ name: "Priya" });
  expect(lead.courseSlug).toBe("hindi-reading-writing");
  expect(lead.userId.toString()).toBe(student._id.toString());

  // Owner notification still goes out, but not the "your demo login is on
  // its way" visitor email — that copy is wrong for someone already logged in.
  expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  expect(sendTransactionalEmail.mock.calls[0][0].htmlContent).toContain("already has an account");
});

test("authenticated submission with an unknown courseSlug → 400, nothing saved", async () => {
  const student = await createStudent();

  const res = await request(app)
    .post("/api/leads")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .set("X-Forwarded-For", nextIp())
    .send({ name: student.name, phone: student.phone, interest: "Kannada", courseSlug: "not-a-real-course" });

  expect(res.status).toBe(400);
  expect(res.body.errors.courseSlug).toBeTruthy();
  expect(await Lead.countDocuments()).toBe(0);
});

test("a valid token without a courseSlug behaves like a plain public lead — no userId attached", async () => {
  const student = await createStudent();

  const res = await request(app)
    .post("/api/leads")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .set("X-Forwarded-For", nextIp())
    .send({ name: student.name, phone: student.phone, interest: "Just curious" });

  expect(res.status).toBe(200);
  const lead = await Lead.findOne({ name: student.name });
  expect(lead.userId).toBeNull();
  expect(lead.courseSlug).toBe("");
});

test("a courseSlug sent without authentication is ignored — can't forge a userId association", async () => {
  const res = await request(app)
    .post("/api/leads")
    .set("X-Forwarded-For", nextIp())
    .send({ name: "Anon", phone: "9876500001", interest: "Kannada", courseSlug: "kannada-speaking" });

  expect(res.status).toBe(200);
  const lead = await Lead.findOne({ name: "Anon" });
  expect(lead.courseSlug).toBe("");
  expect(lead.userId).toBeNull();
});
