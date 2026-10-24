// src/core/manual.js: deadlines the student adds themselves.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateManual, applyManual, PERSONAL_ID } from "../extension/src/core/manual.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const course = (id, code) => ({ id, code, name: "", color: "blue", orgUnitId: 1 });

describe("what the form sends", () => {
  test("a good one becomes an open manual deadline", () => {
    const { item, error } = validateManual({ title: "  Problem   set 3 ", courseId: "ou1", category: "assignment", dueAt: "2026-10-30T03:59:00.000Z" }, null, NOW);
    assert.equal(error, undefined);
    assert.equal(item.title, "Problem set 3");
    assert.equal(item.kind, "manual");
    assert.equal(item.manual, true);
    assert.equal(item.status, "open");
    assert.match(item.id, /^manual:/);
    assert.equal(item.dueAt, "2026-10-30T03:59:00.000Z");
    assert.equal(item.createdAt, NOW.toISOString());
  });

  test("needs a name and a date", () => {
    assert.equal(validateManual({ title: "  ", dueAt: "2026-10-30T03:59:00Z" }).error, "Give it a name.");
    assert.equal(validateManual({ title: "X", dueAt: "not a date" }).error, "Pick a due date and time.");
    assert.match(validateManual({ title: "x".repeat(121), dueAt: "2026-10-30T03:59:00Z" }).error, /under 120/);
  });

  test("a link has to be a web link", () => {
    assert.equal(validateManual({ title: "X", dueAt: "2026-10-30T03:59:00Z", url: "javascript:alert(1)" }).error, "The link has to start with https://");
    assert.equal(validateManual({ title: "X", dueAt: "2026-10-30T03:59:00Z", url: "marmoset.student.cs.uwaterloo.ca" }).error, "The link has to start with https://");
    assert.equal(validateManual({ title: "X", dueAt: "2026-10-30T03:59:00Z", url: "https://marmoset.student.cs.uwaterloo.ca/" }).item.url, "https://marmoset.student.cs.uwaterloo.ca/");
  });

  test("an unknown type is an assignment", () => {
    assert.equal(validateManual({ title: "X", dueAt: "2026-10-30T03:59:00Z", category: "nonsense" }).item.category, "assignment");
  });

  test("editing keeps its id, status and when it was added", () => {
    const prev = { id: "manual:abc", status: "done", completedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z" };
    const { item } = validateManual({ id: "manual:abc", title: "Renamed", courseId: "ou1", dueAt: "2026-11-01T03:59:00Z" }, prev, NOW);
    assert.equal(item.id, "manual:abc");
    assert.equal(item.status, "done");
    assert.equal(item.completedAt, prev.completedAt);
    assert.equal(item.createdAt, prev.createdAt);
  });
});

describe("putting them in the list", () => {
  const mine = (id, courseId) => ({ id, courseId, kind: "manual", manual: true, title: id, dueAt: "2026-10-30T03:59:00.000Z", status: "open" });

  test("added once, whatever the list already had", () => {
    const state = { courses: [course("ou1", "MATH 135")], items: [{ id: "ou1:dropbox:1", courseId: "ou1" }, mine("manual:a", "ou1")] };
    applyManual(state, [mine("manual:a", "ou1"), mine("manual:b", "ou1")]);
    assert.deepEqual(state.items.map((i) => i.id), ["ou1:dropbox:1", "manual:a", "manual:b"]);
    assert.ok(!state.courses.some((c) => c.id === PERSONAL_ID), "no Personal course when nothing needs it");
  });

  test("a course that's gone shows it under Personal, and it goes back when the course returns", () => {
    const stored = [mine("manual:a", "ou1")];
    const s1 = applyManual({ courses: [course("ou2", "CS 137")], items: [] }, stored);
    assert.equal(s1.items[0].courseId, PERSONAL_ID);
    assert.ok(s1.courses.some((c) => c.id === PERSONAL_ID && c.code === "Personal"));
    assert.equal(stored[0].courseId, "ou1", "the stored copy keeps its course");
    const s2 = applyManual({ courses: [course("ou1", "MATH 135"), ...s1.courses], items: s1.items }, stored);
    assert.equal(s2.items[0].courseId, "ou1");
    assert.ok(!s2.courses.some((c) => c.id === PERSONAL_ID), "Personal goes away when empty");
  });

  test("deleting the last one takes them all out", () => {
    const state = applyManual({ courses: [], items: [mine("manual:a", PERSONAL_ID)] }, []);
    assert.deepEqual(state.items, []);
  });
});

describe("a course with nothing posted", () => {
  const mine = (id, courseId) => ({ id, courseId, kind: "manual", manual: true, title: id, dueAt: "2026-10-30T03:59:00.000Z", status: "open" });
  const lab = { id: "ou777", code: "PHYS 1080", name: "Physics Lab", color: "pink", orgUnitId: 777, current: false };

  test("is brought into the list, with its own chip, once it has a deadline", () => {
    const state = applyManual({ courses: [course("ou1", "MATH 1200")], otherCourses: [lab], items: [] }, [mine("manual:a", "ou777")]);
    assert.equal(state.items[0].courseId, "ou777", "not Personal");
    const shown = state.courses.find((c) => c.id === "ou777");
    assert.ok(shown && shown.current, "shown as a current course");
    assert.ok(!state.courses.some((c) => c.id === PERSONAL_ID));
  });

  test("leaves again when its last deadline goes", () => {
    const once = applyManual({ courses: [course("ou1", "MATH 1200")], otherCourses: [lab], items: [] }, [mine("manual:a", "ou777")]);
    const after = applyManual(once, []);
    assert.deepEqual(after.courses.map((c) => c.id), ["ou1"]);
  });
});
