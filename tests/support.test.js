// POST /api/support — the authenticated counterpart to the public
// /api/contact form (contactController.js): sender identity and enrolled
// course(s) come from the account, not a re-typed name/email.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");
const { sendTransactionalEmail } = await import("../src/services/brevoService.js");

beforeAll(connectTestDB);
afterEach(() => {
  sendTransactionalEmail.mockClear();
  return clearTestDB();
});
afterAll(disconnectTestDB);

test("sends an email to the configured support address, with sender + course context", async () => {
  const teacher = await createTeacher({ name: "Sudi" });
  const student = await createStudent({ name: "Priya", email: "priya@example.com" });
  await createEnrollment({ student, tutor: teacher, courseSlug: "kannada" });

  const res = await request(app)
    .post("/api/support")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .send({ message: "My class link isn't working" });

  expect(res.status).toBe(200);
  expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  const call = sendTransactionalEmail.mock.calls[0][0];
  expect(call.to).toBe("owner@example.com"); // tests/setupEnv.js's CLIENT_NOTIFICATION_EMAIL
  expect(call.replyTo).toBe("priya@example.com");
  expect(call.subject).toContain("Priya");
  expect(call.htmlContent).toContain("Priya");
  expect(call.htmlContent).toContain("kannada");
  expect(call.htmlContent).toContain("Sudi");
  expect(call.htmlContent).toContain("My class link isn&#39;t working");
});

test("a student with no enrollment yet → course line says so, doesn't error", async () => {
  const student = await createStudent();

  const res = await request(app)
    .post("/api/support")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .send({ message: "Question before I start" });

  expect(res.status).toBe(200);
  const call = sendTransactionalEmail.mock.calls[0][0];
  expect(call.htmlContent).toContain("Not enrolled yet");
});

test("empty/whitespace-only message → 400, no email sent", async () => {
  const student = await createStudent();

  const res = await request(app)
    .post("/api/support")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .send({ message: "   " });

  expect(res.status).toBe(400);
  expect(sendTransactionalEmail).not.toHaveBeenCalled();
});

test("message over 2000 chars → 400", async () => {
  const student = await createStudent();

  const res = await request(app)
    .post("/api/support")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .send({ message: "a".repeat(2001) });

  expect(res.status).toBe(400);
});

test("no token → 401", async () => {
  const res = await request(app).post("/api/support").send({ message: "Hi" });
  expect(res.status).toBe(401);
});

test("Brevo failure → 502, clear error", async () => {
  sendTransactionalEmail.mockRejectedValueOnce(new Error("Brevo unreachable"));
  const student = await createStudent();

  const res = await request(app)
    .post("/api/support")
    .set("Authorization", `Bearer ${signToken(student)}`)
    .send({ message: "Hi" });

  expect(res.status).toBe(502);
  expect(res.body.success).toBe(false);
});
