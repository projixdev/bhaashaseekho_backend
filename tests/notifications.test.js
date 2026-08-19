// Push notification plumbing (Phase C of the account-lifecycle work):
// registering a token, the Expo push API caller, and the monthly reminder
// job's query/send logic. The job's *scheduling* (node-cron itself) isn't
// tested here — there's nothing meaningful to assert about a cron
// expression firing on a real clock; runMonthlyReloginReminder is exported
// separately specifically so the actual work is testable without it.
import { jest } from "@jest/globals";
import request from "supertest";
import { connectTestDB, clearTestDB, disconnectTestDB } from "./helpers/db.js";
import { createStudent, createTeacher, signToken } from "./helpers/fixtures.js";

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { sendPushNotifications } = await import("../src/services/pushService.js");
const { runMonthlyReloginReminder } = await import("../src/jobs/monthlyReloginReminder.js");

beforeAll(connectTestDB);
afterEach(() => {
  jest.restoreAllMocks();
  return clearTestDB();
});
afterAll(disconnectTestDB);

describe("POST /api/notifications/register-token", () => {
  test("valid token → 200, saved on the user", async () => {
    const student = await createStudent();
    const res = await request(app)
      .post("/api/notifications/register-token")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ pushToken: "ExponentPushToken[abc123]" });

    expect(res.status).toBe(200);
    const stored = await User.findById(student._id);
    expect(stored.pushToken).toBe("ExponentPushToken[abc123]");
  });

  test("re-registering overwrites the previous token", async () => {
    const student = await createStudent();
    const token = signToken(student);
    await request(app).post("/api/notifications/register-token").set("Authorization", `Bearer ${token}`).send({ pushToken: "old-token" });
    await request(app).post("/api/notifications/register-token").set("Authorization", `Bearer ${token}`).send({ pushToken: "new-token" });

    expect((await User.findById(student._id)).pushToken).toBe("new-token");
  });

  test("missing pushToken → 400", async () => {
    const student = await createStudent();
    const res = await request(app)
      .post("/api/notifications/register-token")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test("no token → 401", async () => {
    const res = await request(app).post("/api/notifications/register-token").send({ pushToken: "x" });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/notifications/preferences", () => {
  test("turns notifications off, saved on the user", async () => {
    const student = await createStudent();
    const res = await request(app)
      .patch("/api/notifications/preferences")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.notificationsEnabled).toBe(false);
    expect((await User.findById(student._id)).notificationsEnabled).toBe(false);
  });

  test("non-boolean enabled → 400", async () => {
    const student = await createStudent();
    const res = await request(app)
      .patch("/api/notifications/preferences")
      .set("Authorization", `Bearer ${signToken(student)}`)
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("sendPushNotifications (Expo push API caller)", () => {
  test("sends one request for a small batch, with the right payload shape", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    await sendPushNotifications(["token-a", "token-b"], { title: "Hi", body: "There" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(opts.body);
    expect(body).toEqual([
      { to: "token-a", title: "Hi", body: "There", sound: "default", priority: "high", channelId: "default" },
      { to: "token-b", title: "Hi", body: "There", sound: "default", priority: "high", channelId: "default" },
    ]);
  });

  test("splits more than 100 tokens into multiple batched requests", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    const tokens = Array.from({ length: 150 }, (_, i) => `token-${i}`);

    await sendPushNotifications(tokens, { title: "Hi", body: "There" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toHaveLength(50);
  });

  test("a failed batch is logged, not thrown — best-effort", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 500, text: async () => "server error" });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendPushNotifications(["token-a"], { title: "Hi", body: "There" })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("runMonthlyReloginReminder", () => {
  test("pushes only to students/teachers that have a pushToken registered", async () => {
    const withToken = await createStudent({ name: "Has Token" });
    await User.findByIdAndUpdate(withToken._id, { pushToken: "token-1" });
    await createStudent({ name: "No Token" }); // pushToken stays null
    const teacherWithToken = await createTeacher({ name: "Teacher Has Token" });
    await User.findByIdAndUpdate(teacherWithToken._id, { pushToken: "token-2" });

    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });

    const result = await runMonthlyReloginReminder();

    expect(result.sent).toBe(2);
    const sentTokens = JSON.parse(fetchMock.mock.calls[0][1].body).map((m) => m.to);
    expect(sentTokens.sort()).toEqual(["token-1", "token-2"]);
  });

  test("nobody has a pushToken → no request is made, sent: 0", async () => {
    await createStudent();
    const fetchMock = jest.spyOn(global, "fetch");

    const result = await runMonthlyReloginReminder();

    expect(result.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
