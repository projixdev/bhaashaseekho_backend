// Phase 11 upload hardening, encoded as tests. Server-side only per
// ROADMAP.md Phase 12's explicit exclusion of frontend/app tests — the
// client-side check in src/lib/upload.ts lives in the Expo app repo, not
// here, so multer's own limit/fileFilter (assignmentRoutes.js) is what's
// actually under test. Cloudinary is mocked; every case below that's
// expected to reach the controller needs a real Enrollment first, since
// createAssignment's ownership check runs after multer.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, signToken } from "./helpers/fixtures.js";

jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));
const mockUploadBuffer = jest.fn().mockResolvedValue({ secure_url: "https://res.cloudinary.com/fake/mock.jpg" });
jest.unstable_mockModule("../src/config/cloudinary.js", () => ({ uploadBuffer: mockUploadBuffer }));

const { default: app } = await import("../src/app.js");

beforeAll(connectTestDB);
afterEach(async () => {
  await clearTestDB();
  mockUploadBuffer.mockClear();
});
afterAll(disconnectTestDB);

const OVER_10MB = 10 * 1024 * 1024 + 1;

async function setup() {
  const teacher = await createTeacher();
  const student = await createStudent();
  await createEnrollment({ student, tutor: teacher });
  return { teacher, student };
}

test("oversize file (>10MB) → 400, rejected before it reaches Cloudinary", async () => {
  const { teacher, student } = await setup();
  const res = await request(app)
    .post("/api/assignments")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .field("studentId", student._id.toString())
    .field("type", "homework")
    .field("title", "Big file")
    .attach("file", Buffer.alloc(OVER_10MB), { filename: "big.jpg", contentType: "image/jpeg" });

  expect(res.status).toBe(400);
  expect(res.body.message).toBe("File exceeds the 10MB limit.");
  expect(mockUploadBuffer).not.toHaveBeenCalled();
});

test("disallowed MIME type → 400 with a readable message, not a fallthrough 500", async () => {
  const { teacher, student } = await setup();
  const res = await request(app)
    .post("/api/assignments")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .field("studentId", student._id.toString())
    .field("type", "homework")
    .field("title", "Bad type")
    .attach("file", Buffer.from("not really an exe"), { filename: "tool.exe", contentType: "application/x-msdownload" });

  expect(res.status).toBe(400);
  expect(res.body.message).toBe("Only images and PDF files are allowed.");
  expect(mockUploadBuffer).not.toHaveBeenCalled();
});

test("allowed image (image/jpeg) → accepted, 200", async () => {
  const { teacher, student } = await setup();
  const res = await request(app)
    .post("/api/assignments")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .field("studentId", student._id.toString())
    .field("type", "homework")
    .field("title", "Photo homework")
    .attach("file", Buffer.from("fake jpeg bytes"), { filename: "photo.jpg", contentType: "image/jpeg" });

  expect(res.status).toBe(200);
  expect(res.body.assignment.attachmentUrl).toBe("https://res.cloudinary.com/fake/mock.jpg");
  expect(mockUploadBuffer).toHaveBeenCalledTimes(1);
});

test("allowed document (application/pdf) → accepted, 200", async () => {
  const { teacher, student } = await setup();
  const res = await request(app)
    .post("/api/assignments")
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .field("studentId", student._id.toString())
    .field("type", "assessment")
    .field("title", "Question paper")
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "paper.pdf", contentType: "application/pdf" });

  expect(res.status).toBe(200);
  expect(res.body.assignment.attachmentUrl).toBe("https://res.cloudinary.com/fake/mock.jpg");
  expect(mockUploadBuffer).toHaveBeenCalledTimes(1);
});
