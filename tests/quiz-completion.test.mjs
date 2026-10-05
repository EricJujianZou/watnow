import assert from "node:assert/strict";
import test from "node:test";
import { LiveSource } from "../extension/src/data/live-source.js";
import { plannedReminders } from "../extension/src/core/reminders.js";

const now = new Date("2026-10-03T16:00:00Z");
const completed = "2026-10-02T14:00:00.000Z";
const course = { id: "123", orgUnitId: 123, code: "CS 101" };
const quiz = {
  QuizId: 42,
  Name: "Course survey",
  EndDate: "2026-10-10T16:00:00Z",
  IsActive: true,
};
const item = { id: "123:quiz:42", title: quiz.Name };
const feedItem = {
  OrgUnitId: 123,
  ItemId: 900,
  ActivityType: 4,
  ItemName: quiz.Name,
  ItemUrl: "/d2l/lms/quizzing/user/quiz_summary.d2l?qi=42&ou=123",
  EndDate: quiz.EndDate,
  DateCompleted: completed,
};

function mockSource({ quizzes = [quiz], feed = [], completionFeed = [], onRequest } = {}) {
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
    if (path.endsWith("/quizzes/")) json = { Objects: quizzes, Next: null };
    else if (path.includes("/content/myItems/completions/")) json = { Objects: completionFeed, Next: null };
    else if (path.includes("/content/myItems/")) json = { Objects: feed, Next: null };
    else json = [];
    return { status: 200, type: "application/json", json };
  };
  return { source, calls };
}

async function withQuizPage({ status = 200, html = "", url = "https://learn.uwaterloo.ca/d2l/lms/quizzing/user/quiz_summary.d2l?qi=42&ou=123" } = {}, run) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), options });
    return {
      status,
      ok: status >= 200 && status < 300,
      url,
      text: async () => html,
    };
  };
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a completed quiz with retakes remaining is recognized from the student summary page", async () => {
  const { source, calls } = mockSource();
  await withQuizPage({ html: "<div>Attempts: 3</div><div>Completed - 1</div>" }, async (requests) => {
    const [row] = await source.listDeadlines(course);
    assert.equal(row.status, "submitted");
    assert.equal(row.completedAt, now.toISOString());
    assert.match(requests[0].url, /quiz_summary\.d2l\?qi=42&ou=123$/);
    assert.equal(calls.some(({ path }) => path.includes("/attempts/")), false);
    const settings = { reminders: { mutedCourses: [], leads: { quiz: ["1d"] } } };
    assert.deepEqual(plannedReminders([row], settings, now), []);
  });
});

test("a quiz with zero completed attempts remains open", async () => {
  const { source } = mockSource();
  await withQuizPage({ html: "<div>Attempts: 3</div><div>Completed - 0</div>" }, async () => {
    const [row] = await source.listDeadlines(course);
    assert.equal(row.status, "open");
    assert.equal(row.completedAt, null);
  });
});

test("when the summary page is unavailable, the content completions feed remains a fallback", async () => {
  const { source, calls } = mockSource({ completionFeed: [feedItem] });
  await withQuizPage({ status: 403 }, async () => {
    assert.deepEqual(await source.submissionState(item), { submitted: true, at: completed });
    assert.equal(calls.some(({ path }) => path.includes("/attempts/")), false);
    assert.equal(source.report.requests.find(({ path }) => path.includes("quiz_summary"))?.status, 403);
  });
});

test("an unavailable summary page and empty completion feed report the quiz as unsubmitted", async () => {
  const { source } = mockSource();
  await withQuizPage({ status: 403 }, async () => {
    assert.deepEqual(await source.submissionState(item), { submitted: false });
  });
});

test("an unrecognized summary page is skipped for the rest of the run", async () => {
  const { source } = mockSource();
  await withQuizPage({ html: "<div>Quiz Summary</div>" }, async (requests) => {
    assert.deepEqual(await source.submissionState(item), { submitted: false });
    assert.equal(await source.quizDone(123, "42"), null);
    assert.equal(requests.length, 1);
    assert.ok(source.report.notes.includes("quiz summary page has no completed count"));
  });
});

test("a login redirect during sync is treated as a signed-out session", async () => {
  const { source } = mockSource();
  await withQuizPage({ url: "https://learn.uwaterloo.ca/d2l/login" }, async () => {
    await assert.rejects(source.listDeadlines(course), { code: "signed-out" });
  });
});

test("submission checks still recognize dropbox submissions", async () => {
  const { source } = mockSource({ onRequest(path) {
    if (path.includes("/mysubmissions/")) return { status: 200, json: [{ Submissions: [{ SubmissionDate: completed }] }] };
  } });
  assert.deepEqual(await source.submissionState({ id: "123:dropbox:42" }), { submitted: true, at: completed });
});
