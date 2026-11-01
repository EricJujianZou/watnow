// src/calendar/outlook-sync.js: what the Outlook calendar needs doing to match the list.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  runtime: { getURL: () => "chrome-extension://test/", getManifest: () => ({}) },
  alarms: { create: async () => {}, clear: async () => {} },
  identity: { getRedirectURL: () => "https://test.chromiumapp.org/outlook" },
};

const { outlookPlan, outlookKey } = await import("../extension/src/calendar/outlook-sync.js");
const { outlookEvent, outlookFingerprint } = await import("../extension/src/calendar/outlook-model.js");

const NOW = Date.parse("2026-11-01T12:00:00Z");
const course = { id: "ou1", code: "MATH 135", name: "Algebra" };
const item = (id, dueAt, status = "open") => ({ id, courseId: "ou1", kind: "dropbox", category: "assignment", title: id, dueAt, status, url: "https://learn.example/x" });
const state = (items, courses = [course]) => ({ courses, items });
const recordFor = (it) => {
  const key = outlookKey("uwaterloo", it);
  return { [key]: { graphId: `g-${it.id}`, fingerprint: outlookFingerprint(outlookEvent(it, course, key)), courseId: "ou1" } };
};

describe("new events", () => {
  test("only upcoming open deadlines get one", () => {
    const plan = outlookPlan(state([item("a", "2026-11-05T03:59:00Z"), item("past", "2026-10-01T03:59:00Z"), item("done", "2026-11-06T03:59:00Z", "done")]), "uwaterloo", {}, NOW);
    assert.deepEqual(plan.map((p) => `${p.action} ${p.key}`), ["create uwaterloo:a"]);
    assert.equal(plan[0].courseId, "ou1");
    assert.ok(plan[0].event && plan[0].fingerprint);
  });

  test("items with no course or no date are skipped", () => {
    const plan = outlookPlan(state([{ ...item("x", "2026-11-05T03:59:00Z"), courseId: "nope" }, item("y", "not a date")]), "uwaterloo", {}, NOW);
    assert.deepEqual(plan, []);
  });
});

describe("events that exist", () => {
  test("nothing to do when nothing changed", () => {
    const a = item("a", "2026-11-05T03:59:00Z");
    assert.deepEqual(outlookPlan(state([a]), "uwaterloo", recordFor(a), NOW), []);
  });

  test("a moved date updates it", () => {
    const a = item("a", "2026-11-05T03:59:00Z");
    const plan = outlookPlan(state([{ ...a, dueAt: "2026-11-07T03:59:00Z" }]), "uwaterloo", recordFor(a), NOW);
    assert.deepEqual(plan.map((p) => `${p.action} ${p.graphId}`), ["update g-a"]);
  });

  test("a check-off updates it, even once it's past due", () => {
    const a = item("a", "2026-10-30T03:59:00Z");
    const plan = outlookPlan(state([{ ...a, status: "done" }]), "uwaterloo", recordFor(a), NOW);
    assert.deepEqual(plan.map((p) => p.action), ["update"]);
  });
});

describe("events whose deadline is gone", () => {
  test("deleted while the course is still listed", () => {
    const a = item("a", "2026-11-05T03:59:00Z");
    const plan = outlookPlan(state([]), "uwaterloo", recordFor(a), NOW);
    assert.deepEqual(plan.map((p) => `${p.action} ${p.graphId}`), ["delete g-a"]);
  });

  test("kept when the whole course is gone (end of term)", () => {
    const a = item("a", "2026-11-05T03:59:00Z");
    assert.deepEqual(outlookPlan(state([], []), "uwaterloo", recordFor(a), NOW), []);
  });

  test("one already removed comes back as a new event if the deadline returns", () => {
    const a = item("a", "2026-11-05T03:59:00Z");
    const key = outlookKey("uwaterloo", a);
    const plan = outlookPlan(state([a]), "uwaterloo", { [key]: { removed: true, courseId: "ou1" } }, NOW);
    assert.deepEqual(plan.map((p) => p.action), ["create"]);
  });

  test("another school's events are left alone", () => {
    const records = { "uoguelph:ou9:dropbox:1": { graphId: "g-other", fingerprint: "x", courseId: "ou1" } };
    assert.deepEqual(outlookPlan(state([]), "uwaterloo", records, NOW), []);
  });
});
