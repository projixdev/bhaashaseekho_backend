// PATCH /api/profile — editable name/email for the app's Profile screen.
// Phone is deliberately not accepted (it's the OTP login identifier).
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, signToken } from "./helpers/fixtures.js";

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

function patchProfile(user, body) {
  return request(app).patch("/api/profile").set("Authorization", `Bearer ${signToken(user)}`).send(body);
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
