import assert from "node:assert/strict";
import test from "node:test";
import { LiveSource, queryForReport } from "../extension/src/data/live-source.js";
import { plannedReminders } from "../extension/src/core/reminders.js";

const now = new Date("2026-10-03T16:00:00Z");
const completed = "2026-10-02T14:00:00.000Z";
const course = { id: "123", orgUnitId: 123, code: "CS 101" };
const quiz = {
  QuizId: 42,
  Name: "Course survey",
  EndDate: "2026-10-10T16:00:00Z",
  IsActive: true,
  AttemptsAllowed: { IsUnlimited: true, NumberOfAttemptsAllowed: null },
};
const item = { id: "123:quiz:42", title: quiz.Name };
const attempt = (changes = {}) => ({ QuizId: 42, UserId: 7, Completed: completed, IsPublished: false, ...changes });
const feedItem = {
  OrgUnitId: 123, ItemId: 900, ActivityType: 4, ItemName: quiz.Name,
  ItemUrl: "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=42&ou=123",
  EndDate: quiz.EndDate, DateCompleted: completed,
};

function mockSource({ quizzes = [quiz], attempts = [attempt()], feed = [], completionFeed = [], onRequest } = {}) {
  const source = new LiveSource({}, { now });
  source.versions = { lp: "1.50", le: "1.82" };
  source.courseIds = new Set([123]);
  source.report.courses = [{ orgUnitId: 123, tools: {} }];
  const calls = [];
  source.fetchVia = async (path, via) => {
    calls.push({ path, via });
    const custom = onRequest?.(path, via);
    if (custom) return custom;
    let json;
    if (path.includes("/users/whoami")) json = { Identifier: "7", FirstName: "Student" };
    else if (path.includes("/attempts/")) {
      assert.equal(new URL(path, source.base).searchParams.get("userId"), "7");
      json = { Objects: attempts, Next: null };
    } else if (path.endsWith("/quizzes/")) json = { Objects: quizzes, Next: null };
    else if (path.includes("/content/myItems/completions/")) json = { Objects: completionFeed, Next: null };
    else if (path.includes("/content/myItems/")) json = { Objects: feed, Next: null };
    else json = [];
    return { status: 200, type: "application/json", json };
  };
  return { source, calls };
}

for (const allowed of [
  { IsUnlimited: true, NumberOfAttemptsAllowed: null },
  { IsUnlimited: false, NumberOfAttemptsAllowed: 3 },
  { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
]) {
  test(`sync recognizes a submitted attempt with allowance ${JSON.stringify(allowed)}`, async () => {
    const { source } = mockSource({ quizzes: [{ ...quiz, AttemptsAllowed: allowed }], feed: [feedItem] });
    const items = await source.listDeadlines(course);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "submitted");
    assert.equal(items[0].completedAt, completed);
    const settings = { reminders: { mutedCourses: [], leads: { quiz: ["1d"] } } };
    assert.deepEqual(plannedReminders(items, settings, now), []);
  });
}

test("sync keeps unattempted and in-progress quizzes open", async () => {
  for (const attempts of [[], [attempt({ Completed: null })], [attempt({ Completed: "bad date" })]]) {
    const { source } = mockSource({ attempts });
    const [row] = await source.listDeadlines(course);
    assert.equal(row.status, "open");
    assert.equal(row.completedAt, null);
  }
});

test("a later in-progress retake does not undo a submitted attempt", async () => {
  const { source } = mockSource({ attempts: [attempt(), attempt({ Completed: null })] });
  assert.deepEqual(await source.submissionState(item), { submitted: true, at: completed });
});

test("attempts for another student or quiz do not count", async () => {
  const { source } = mockSource({ attempts: [attempt({ UserId: 8 }), attempt({ QuizId: 43 })] });
  const [row] = await source.listDeadlines(course);
  assert.equal(row.status, "open");
  assert.deepEqual(await source.submissionState(item), { submitted: false });
});

test("feed-only quizzes also use submitted attempts", async () => {
  const { source } = mockSource({ quizzes: [], feed: [feedItem] });
  const [row] = await source.listDeadlines(course);
  assert.equal(row.status, "submitted");
  assert.equal(row.id, item.id);
});

test("a content id without a quiz link is not used as a quiz id", async () => {
  const { source, calls } = mockSource({ quizzes: [], feed: [{ ...feedItem, ItemUrl: null }] });
  const [row] = await source.listDeadlines(course);
  assert.equal(row.status, "open");
  assert.equal(calls.some((c) => c.path.includes("/attempts/")), false);
});

test("the debug report redacts the student id in attempts requests", async () => {
  assert.deepEqual(queryForReport("/attempts/?userId=7"), { userId: "<redacted>" });
  const { source } = mockSource();
  await source.submissionState(item);
  const request = source.report.requests.find((r) => r.path.includes("/attempts/"));
  assert.equal(request.query.userId, "<redacted>");
  assert.equal(source.report.shapes[request.endpoint].Objects[0].UserId, "<redacted>");
});

test("bookmark pagination keeps the requested fetch transport", async () => {
  const { source, calls } = mockSource({ onRequest(path, via) {
    if (!path.includes("/attempts/")) return;
    if (via === "worker") return { status: 0 };
    const page = new URL(path, source.base).searchParams.has("bookmark");
    return { status: 200, json: {
      Objects: page ? [attempt()] : [attempt({ Completed: null })],
      PagingInfo: { HasMoreItems: !page, Bookmark: page ? null : "second page" },
    } };
  } });
  source.relay = async () => {};
  assert.deepEqual(await source.submissionState(item), { submitted: true, at: completed });
  assert.equal(calls.filter((c) => c.via === "tab" && c.path.includes("/attempts/")).length, 2);
});

test("an expired Learn session propagates during sync", async () => {
  const { source } = mockSource({ onRequest(path) {
    if (path.includes("/attempts/")) return { status: 401 };
  } });
  await assert.rejects(source.listDeadlines(course), { code: "signed-out" });
});

test("submission checks still recognize dropbox submissions", async () => {
  const { source } = mockSource({ onRequest(path) {
    if (path.includes("/mysubmissions/")) return { status: 200, json: [{ Submissions: [{ SubmissionDate: completed }] }] };
  } });
  assert.deepEqual(await source.submissionState({ id: "123:dropbox:42" }), { submitted: true, at: completed });
});

test("attempts are paginated, and the latest submitted date wins", async () => {
  const later = "2026-10-03T12:00:00.000Z";
  const { source, calls } = mockSource({ onRequest(path) {
    if (!path.includes("/attempts/")) return;
    const url = new URL(path, source.base);
    const json = url.searchParams.has("bookmark")
      ? { Objects: [attempt({ Completed: later })], Next: null }
      : { Objects: [attempt()], Next: `${url.pathname}?userId=7&bookmark=next` };
    return { status: 200, json };
  } });
  assert.deepEqual(await source.submissionState(item), { submitted: true, at: later });
  assert.equal(calls.filter((c) => c.path.includes("/attempts/")).length, 2);
});

test("a denied attempts request keeps deadlines and falls back to feed completion", async () => {
  const { source } = mockSource({ feed: [feedItem], completionFeed: [feedItem], onRequest(path) {
    if (path.includes("/attempts/")) return { status: 403 };
  } });
  const [row] = await source.listDeadlines(course);
  assert.equal(row.status, "submitted");
  assert.deepEqual(await source.submissionState(item), { submitted: true, at: completed });
});

test("an unavailable attempts request leaves the quiz visible", async () => {
  const { source } = mockSource({ onRequest(path) {
    if (path.includes("/attempts/")) return { status: 403 };
  } });
  const [row] = await source.listDeadlines(course);
  assert.equal(row.status, "open");
  assert.equal(row.id, item.id);
});

test("missing student identity never triggers an unfiltered attempts request", async () => {
  const { source, calls } = mockSource({ onRequest(path) {
    if (path.includes("/users/whoami")) return { status: 200, json: { FirstName: "Student" } };
  } });
  const [row] = await source.listDeadlines(course);
  assert.equal(row.status, "open");
  assert.equal(calls.some((c) => c.path.includes("/attempts/")), false);
});

test("the pre-reminder check retries attempts through an open Learn tab", async () => {
  const { source, calls } = mockSource({ onRequest(path, via) {
    if (via === "worker" && !path.includes("/users/whoami")) return { status: 0, error: "network" };
  } });
  source.relay = async () => {};
  assert.deepEqual(await source.submissionState(item), { submitted: true, at: completed });
  assert.ok(calls.some((c) => c.via === "tab" && c.path.includes("/attempts/")));
});

for (const failedRoute of ["completions/due/", "completions/"]) {
  test(`a failed ${failedRoute} route does not hide another completion result`, async () => {
    const { source } = mockSource({ completionFeed: [feedItem], onRequest(path) {
      if (path.includes("/attempts/") || path.includes(`/myItems/${failedRoute}?`)) return { status: 403 };
    } });
    assert.deepEqual(await source.submissionState(item), { submitted: true, at: completed });
  });
}

test("a completed content item with the same name is not a quiz submission", async () => {
  const { source } = mockSource({ attempts: [], completionFeed: [{ ...feedItem, ActivityType: 1, ItemUrl: null }] });
  assert.deepEqual(await source.submissionState(item), { submitted: false });
});

test("an unavailable submission check returns unknown rather than unsubmitted", async () => {
  const { source } = mockSource({ onRequest(path) {
    if (!path.includes("/users/whoami")) return { status: 0 };
  } });
  assert.equal(await source.submissionState(item), null);
});
