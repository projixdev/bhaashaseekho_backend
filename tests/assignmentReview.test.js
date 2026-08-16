// Reviewed must mean graded, not just "looked at" — see the validation
// comment in assignmentController.js's reviewAssignment.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createAssignmentDoc, signToken } from "./helpers/fixtures.js";
import Assignment from "../src/models/Assignment.js";

// reviewAssignment now fires notifyAssignmentReviewed (Phase 18), which
// emails the student — mocked here so these tests never make a real network
// call, same as every other file that exercises an endpoint behind a
// notification trigger.
jest.unstable_mockModule("../src/services/brevoService.js", () => ({
  sendTransactionalEmail: jest.fn().mockResolvedValue({}),
}));

const { default: app } = await import("../src/app.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

async function setup() {
  const teacher = await createTeacher();
  const student = await createStudent();
  const assignment = await createAssignmentDoc({ student, tutor: teacher });
  return { teacher, student, assignment };
}

test("review with no score → 400, status stays unchanged", async () => {
  const { teacher, assignment } = await setup();

  const res = await request(app)
    .patch(`/api/assignments/${assignment._id}/review`)
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({});

  expect(res.status).toBe(400);
  expect(res.body.message).toBe("A score is required to mark this assignment reviewed.");

  const unchanged = await Assignment.findById(assignment._id);
  expect(unchanged.status).toBe("assigned");
  expect(unchanged.score).toBe("");
});

test("review with a blank/whitespace-only score → 400", async () => {
  const { teacher, assignment } = await setup();

  const res = await request(app)
    .patch(`/api/assignments/${assignment._id}/review`)
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ score: "   " });

  expect(res.status).toBe(400);
  expect(res.body.message).toBe("A score is required to mark this assignment reviewed.");
});

test("review with a score → 200, status becomes reviewed", async () => {
  const { teacher, assignment } = await setup();

  const res = await request(app)
    .patch(`/api/assignments/${assignment._id}/review`)
    .set("Authorization", `Bearer ${signToken(teacher)}`)
    .send({ score: "8/10" });

  expect(res.status).toBe(200);
  expect(res.body.assignment.status).toBe("reviewed");
  expect(res.body.assignment.score).toBe("8/10");
});
