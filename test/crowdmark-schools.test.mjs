// src/data/crowdmark-source.js: Crowdmark for the schools it signs in for.
//
// Crowdmark's sign-in address carries an institution slug
// (app.crowdmark.com/sign-in/<slug>). The slugs here were checked against
// Crowdmark on Oct 31, 2026: waterloo, mcmaster, guelph, queensu, wlu and
// uwo answer with that school's sign-in page; TMU and Brock get a 404.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  permissions: { contains: async () => true },
  runtime: { getURL: () => "chrome-extension://test/" },
};

const { parseCrowdmarkCourse, crowdmarkAllowed, crowdmarkSignIn, crowdmarkSupported, readCrowdmark } = await import("../extension/src/data/crowdmark-source.js");

const NOW = new Date("2026-10-04T12:00:00Z"); // Fall 2026 is 1269

describe("parseCrowdmarkCourse", () => {
  test("Waterloo: a three-digit code, the term from the words", () => {
    assert.deepEqual(parseCrowdmarkCourse("ECE 207 - Fall 2026", "ece-207-fall-2026"), { code: "ECE 207", term: 1269, hasCode: true });
  });

  test("Waterloo: the term can come from a UW term code in the slug", () => {
    assert.equal(parseCrowdmarkCourse("ECE 207", "ece-207-1269").term, 1269);
  });

  test("Guelph: a four-digit course number is a code, not a Waterloo term", () => {
    // With UW term codes on, 1155 would read as Spring 2015 and the course would be skipped.
    assert.equal(parseCrowdmarkCourse("MATH 1155 - Fall 2026", "math-1155-fall-2026", true).term, 1155);
    assert.deepEqual(parseCrowdmarkCourse("MATH 1155 - Fall 2026", "math-1155-fall-2026", false), { code: "MATH 1155", term: 1269, hasCode: true });
    // Guelph writes its codes with a star.
    assert.deepEqual(parseCrowdmarkCourse("MATH*1155 - Fall 2026", "math-1155-fall-2026", false), { code: "MATH 1155", term: 1269, hasCode: true });
  });

  test("McMaster: a letter in the middle of the number is still a code", () => {
    assert.deepEqual(parseCrowdmarkCourse("MATH 1ZA3 - Fall 2026", "math-1za3-fall-2026", false), { code: "MATH 1ZA3", term: 1269, hasCode: true });
    assert.equal(parseCrowdmarkCourse("ENGINEER 1P13 - Fall 2026", "", false).code, "ENGINEER 1P13");
    assert.equal(parseCrowdmarkCourse("COMPSCI 2C03 - Fall 2026", "", false).code, "COMPSCI 2C03");
  });

  test("a name with no code keeps the old fallback", () => {
    const p = parseCrowdmarkCourse("Engineering Co-op Community - Fall 2026", "", false);
    assert.equal(p.hasCode, false);
    assert.equal(p.term, 1269);
  });
});

describe("which schools can connect Crowdmark", () => {
  const on = ["uwaterloo", "mcmaster", "uoguelph", "wlu", "queensu", "uwo"];
  const off = ["tmu"];

  for (const id of on) {
    test(`${id}: supported, and the sign-in page is that school's`, async () => {
      const settings = { school: id };
      assert.equal(crowdmarkSupported(settings), true);
      assert.equal(await crowdmarkAllowed(settings), true);
      assert.match(crowdmarkSignIn(settings), /^https:\/\/app\.crowdmark\.com\/sign-in\/[a-z]+$/);
    });
  }

  for (const id of off) {
    test(`${id}: not supported, even with the permission granted`, async () => {
      const settings = { school: id };
      assert.equal(crowdmarkSupported(settings), false);
      assert.equal(await crowdmarkAllowed(settings), false);
      // Not Waterloo's sign-in: Crowdmark's own general one.
      assert.equal(crowdmarkSignIn(settings), "https://app.crowdmark.com/sign-in");
    });
  }

  test("the slugs Crowdmark actually uses", () => {
    assert.equal(crowdmarkSignIn({ school: "uwaterloo" }), "https://app.crowdmark.com/sign-in/waterloo");
    assert.equal(crowdmarkSignIn({ school: "uoguelph" }), "https://app.crowdmark.com/sign-in/guelph");
    assert.equal(crowdmarkSignIn({ school: "mcmaster" }), "https://app.crowdmark.com/sign-in/mcmaster");
    assert.equal(crowdmarkSignIn({ school: "queensu" }), "https://app.crowdmark.com/sign-in/queensu");
    assert.equal(crowdmarkSignIn({ school: "wlu" }), "https://app.crowdmark.com/sign-in/wlu");
    assert.equal(crowdmarkSignIn({ school: "uwo" }), "https://app.crowdmark.com/sign-in/uwo");
  });

  test("no school picked yet means Waterloo, as before", async () => {
    assert.equal(crowdmarkSupported({}), true);
    assert.equal(await crowdmarkAllowed({}), true);
    assert.equal(crowdmarkSignIn({}), "https://app.crowdmark.com/sign-in/waterloo");
  });
});

describe("readCrowdmark at another school", () => {
  const asJson = (body) => ({
    ok: true, status: 200, redirected: false, url: "https://app.crowdmark.com/x",
    headers: { get: () => "application/vnd.api+json" }, json: async () => body,
  });
  const COURSES = { data: [{ id: "math-1155-fall-2026", type: "courses", attributes: { name: "MATH 1155 - Fall 2026" }, relationships: {} }] };
  const ASSIGNMENTS = {
    data: [{ id: "a1", type: "assignments", attributes: { due: "2026-10-10T03:59:00Z", "submitted-at": null, "is-locked": false }, relationships: { "exam-master": { data: { type: "exam-masters", id: "em-1" } } } }],
    included: [{ type: "exam-masters", id: "em-1", attributes: { title: "Assignment 2", type: "assigned" } }],
  };

  test("a Guelph course with a four-digit number is read and filed under its CourseLink course", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => asJson(String(url).includes("/student/courses") ? COURSES : ASSIGNMENTS);
    try {
      const learn = [{ id: "55001", code: "MATH 1155", name: "", orgUnitId: 55001, color: "blue" }];
      const r = await readCrowdmark({ school: "uoguelph" }, learn, { now: NOW });
      assert.equal(r.status, "ok");
      assert.equal(r.items.length, 1);
      assert.equal(r.items[0].courseId, "55001");
      assert.equal(r.courses.length, 0, "matched a CourseLink course, so no course of its own");
    } finally {
      globalThis.fetch = original;
    }
  });
});
