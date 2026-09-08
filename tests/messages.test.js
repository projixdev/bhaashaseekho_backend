// Chat between a tutor and their own students (Phase 20 Option 1: plain
// REST + polling, backed by the existing Expo push pipeline — see
// messagesController.js). pushService isn't mocked here: fixtures leave
// pushToken at its default null, so sendMessage's push branch never fires
// and no real network call happens.
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, createEnrollment, signToken } from "./helpers/fixtures.js";

const { default: app } = await import("../src/app.js");
const { default: Conversation } = await import("../src/models/Conversation.js");
const { default: Message } = await import("../src/models/Message.js");

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(disconnectTestDB);

describe("GET /api/messages/conversations", () => {
  test("teacher sees every roster student, even with no messages yet", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        otherUserId: student._id.toString(),
        name: student.name,
        phone: student.phone,
        lastMessageText: "",
        lastMessageAt: null,
        unreadCount: 0,
      },
    ]);
  });

  test("student sees every tutor they're enrolled with, but not an unassigned enrollment (tutor: null)", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher, courseSlug: "kannada" });
    await createEnrollment({ student, tutor: null, courseSlug: "hindi" });

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Authorization", `Bearer ${signToken(student)}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].otherUserId).toBe(teacher._id.toString());
  });

  test("two enrollments with the same tutor (different courses) collapse into one conversation entry", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher, courseSlug: "kannada" });
    await createEnrollment({ student, tutor: teacher, courseSlug: "hindi" });

    const res = await request(app)
      .get("/api/messages/conversations")
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.body.conversations).toHaveLength(1);
  });

  test("after a message is sent, lastMessageText/lastMessageAt and the recipient's unreadCount reflect it", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "See you at 5pm" });

    const asTeacher = await request(app)
      .get("/api/messages/conversations")
      .set("Authorization", `Bearer ${signToken(teacher)}`);
    expect(asTeacher.body.conversations[0].lastMessageText).toBe("See you at 5pm");
    expect(asTeacher.body.conversations[0].unreadCount).toBe(0); // sender never counts their own message as unread

    const asStudent = await request(app)
      .get("/api/messages/conversations")
      .set("Authorization", `Bearer ${signToken(student)}`);
    expect(asStudent.body.conversations[0].lastMessageText).toBe("See you at 5pm");
    expect(asStudent.body.conversations[0].unreadCount).toBe(1);
  });
});

describe("POST /api/messages/conversations/:otherUserId", () => {
  test("teacher sends to their own student → 200, persisted, conversation created lazily", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "Hello!" });

    expect(res.status).toBe(200);
    expect(res.body.message.text).toBe("Hello!");
    expect(res.body.message.sender).toBe(teacher._id.toString());

    const conversation = await Conversation.findOne({ tutor: teacher._id, student: student._id });
    expect(conversation).not.toBeNull();
    expect(conversation.lastMessageText).toBe("Hello!");
    expect(await Message.countDocuments({ conversation: conversation._id })).toBe(1);
  });

  test("student sends to their own tutor → 200", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app)
      .post(`/api/messages/conversations/${teacher._id}`)
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ text: "Question about homework" });

    expect(res.status).toBe(200);
    const conversation = await Conversation.findOne({ tutor: teacher._id, student: student._id });
    expect(conversation.lastMessageText).toBe("Question about homework");
  });

  test("teacher messaging a student not on their roster → 403, nothing persisted", async () => {
    const teacher = await createTeacher();
    const otherTeacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: otherTeacher });

    const res = await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "Hi" });

    expect(res.status).toBe(403);
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  test("student messaging a tutor they aren't enrolled with → 403", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();

    const res = await request(app)
      .post(`/api/messages/conversations/${teacher._id}`)
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ text: "Hi" });

    expect(res.status).toBe(403);
  });

  test("empty/whitespace-only text → 400", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "   " });

    expect(res.status).toBe(400);
  });

  test("text over 2000 chars → 400", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "a".repeat(2001) });

    expect(res.status).toBe(400);
  });

  // Reproduces a real production incident: a client-side nav bug sent the
  // literal string "undefined" as :otherUserId, which previously reached
  // Enrollment.findOne and crashed as an unhandled Mongoose CastError
  // instead of a clean 400.
  test("otherUserId that isn't a valid ObjectId → 400, not a 500", async () => {
    const teacher = await createTeacher();

    const res = await request(app)
      .post("/api/messages/conversations/undefined")
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "Hi" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid user id.");
  });

  test("a second message reuses the same conversation instead of creating another", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "First" });
    await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "Second" });

    expect(await Conversation.countDocuments()).toBe(1);
    expect(await Message.countDocuments()).toBe(2);
  });

  test("push notification body is generic — the actual message text never leaves the server in the push payload", async () => {
    const { jest } = await import("@jest/globals");
    const { default: User } = await import("../src/models/User.js");
    const teacher = await createTeacher({ name: "Sudi Shetty" });
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await User.findByIdAndUpdate(student._id, { pushToken: "stu-token" });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ data: [] }) });

    await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "Meet me at the usual link, my phone number is 9999999999" });

    const pushed = JSON.parse(fetchMock.mock.calls[0][1].body)[0];
    expect(pushed.to).toBe("stu-token");
    // A push body/title is what a locked iOS device shows by default — the
    // actual message text must never appear there. It's not carried in
    // `data` either: the app has no notification-tap listener today, so
    // there's no present need to route it through push infrastructure at
    // all (it's already fetchable via the normal conversation history call).
    expect(pushed.body).toBe("New message from Sudi Shetty");
    expect(pushed.body).not.toMatch(/9999999999|usual link/);
    expect(pushed.title).toBe("Sudi Shetty");
    expect(pushed.data).toEqual({ type: "new-message", otherUserId: teacher._id.toString() });
    fetchMock.mockRestore();
  });

  test("a recipient with notificationsEnabled: false never gets a push, even with a pushToken", async () => {
    const { jest } = await import("@jest/globals");
    const { default: User } = await import("../src/models/User.js");
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });
    await User.findByIdAndUpdate(student._id, { pushToken: "stu-token", notificationsEnabled: false });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "", json: async () => ({ data: [] }) });

    await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "Hi" });

    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe("GET /api/messages/conversations/:otherUserId", () => {
  test("returns history oldest-first and marks the other party's messages read", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "First" });
    await request(app)
      .post(`/api/messages/conversations/${teacher._id}`)
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ text: "Second" });

    const res = await request(app)
      .get(`/api/messages/conversations/${teacher._id}`)
      .set("Authorization", `Bearer ${signToken(student)}`);

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m) => m.text)).toEqual(["First", "Second"]);

    const conversation = await Conversation.findOne({ tutor: teacher._id, student: student._id });
    const teacherMessage = await Message.findOne({ conversation: conversation._id, text: "First" });
    expect(teacherMessage.readAt).not.toBeNull(); // read by the student's fetch above
  });

  test("?after=<messageId> returns only messages sent after that cursor", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const first = await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "First" });
    await request(app)
      .post(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`)
      .send({ text: "Second" });

    const res = await request(app)
      .get(`/api/messages/conversations/${teacher._id}?after=${first.body.message._id}`)
      .set("Authorization", `Bearer ${signToken(student)}`);

    expect(res.body.messages.map((m) => m.text)).toEqual(["Second"]);
  });

  test("no messages yet → empty array, not an error", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: teacher });

    const res = await request(app)
      .get(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  test("fetching a non-enrolled counterpart's history → 403", async () => {
    const teacher = await createTeacher();
    const otherTeacher = await createTeacher();
    const student = await createStudent();
    await createEnrollment({ student, tutor: otherTeacher });

    const res = await request(app)
      .get(`/api/messages/conversations/${student._id}`)
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(403);
  });

  test("otherUserId that isn't a valid ObjectId → 400, not a 500", async () => {
    const teacher = await createTeacher();

    const res = await request(app)
      .get("/api/messages/conversations/undefined")
      .set("Authorization", `Bearer ${signToken(teacher)}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid user id.");
  });
});
