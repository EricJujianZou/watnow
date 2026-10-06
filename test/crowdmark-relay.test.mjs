// src/data/crowdmark-source.js: the worker-then-tab read.
//
// Chrome attaches the Crowdmark session to a request from the background;
// Gecko does not always, and a read with no cookie looks exactly like being
// signed out. These cover the fallback that exists because of it.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// crowdmark-source.js asks chrome.permissions whether Crowdmark is connected,
// so the stub goes in before it is loaded.
globalThis.chrome = {
  permissions: { contains: async () => true },
  runtime: { getURL: () => "chrome-extension://test/" },
};

const { readCrowdmark, crowdmarkSubmitted } = await import("../extension/src/data/crowdmark-source.js");

const NOW = new Date("2026-10-04T12:00:00Z"); // Fall 2026
const LEARN = [{ id: "99001", code: "ECE 207", name: "", orgUnitId: 99001, color: "blue" }];

const COURSES = { data: [{ id: "ece-207-fall-2026", type: "courses", attributes: { name: "ECE 207 - Fall 2026" }, relationships: {} }] };
const ASSIGNMENTS = {
  data: [
    {
      id: "aaaa-bbbb",
      type: "assignments",
      attributes: { due: "2026-10-10T03:59:00Z", "submitted-at": null, "is-locked": false },
      relationships: { "exam-master": { data: { type: "exam-masters", id: "em-1" } } },
    },
  ],
  included: [{ type: "exam-masters", id: "em-1", attributes: { title: "Lab 3 Report", type: "assigned" } }],
};

const bodyFor = (path) => (path.startsWith("/api/v2/student/courses") ? COURSES : ASSIGNMENTS);

const asJson = (body) => ({
  ok: true, status: 200, redirected: false, url: "https://app.crowdmark.com/x",
  headers: { get: () => "application/vnd.api+json" }, json: async () => body,
});
const unauthorized = () => ({
  ok: false, status: 401, redirected: false, url: "https://app.crowdmark.com/x",
  headers: { get: () => "application/json" }, json: async () => ({}),
});
const down = () => ({
  ok: false, status: 503, redirected: false, url: "https://app.crowdmark.com/x",
  headers: { get: () => "text/html" }, text: async () => "down",
});

/** A Crowdmark tab that answers the same GET from the page's own origin. */
const tabWorks = async (path) => ({ status: 200, redirected: false, type: "application/vnd.api+json", json: bodyFor(path) });
const noTab = async () => ({ noTab: true });

const settings = { school: "uwaterloo" };
let fetchCalls = 0;
beforeEach(() => { fetchCalls = 0; });
const serve = (fn) => { globalThis.fetch = async (url) => { fetchCalls++; return fn(url); }; };

describe("the background can read Crowdmark itself", () => {
  before(() => serve((url) => asJson(bodyFor(new URL(url).pathname + new URL(url).search))));

  test("it reads, and says the background is what carried it", async () => {
    const r = await readCrowdmark(settings, LEARN, { relay: tabWorks, now: NOW });
    assert.equal(r.status, "ok");
    assert.equal(r.report.via, "worker");
    assert.equal(r.items.length, 1);
  });

  test("an item goes under the Learn course with the same code", async () => {
    const r = await readCrowdmark(settings, LEARN, { relay: tabWorks, now: NOW });
    assert.equal(r.items[0].courseId, "99001");
    assert.equal(r.items[0].title, "Lab 3 Report");
    assert.equal(r.courses.length, 0, "no course of its own when it matched one on Learn");
  });

  test("with no Learn course to match, it becomes a course of its own", async () => {
    const r = await readCrowdmark(settings, [], { relay: tabWorks, now: NOW });
    assert.equal(r.courses.length, 1);
    assert.equal(r.courses[0].id, "cm:ece-207-fall-2026");
    assert.equal(r.courses[0].crowdmark, true);
    assert.equal(r.items[0].courseId, "cm:ece-207-fall-2026");
  });
});

describe("the background has no session, which is the Gecko case", () => {
  before(() => serve(() => unauthorized()));

  test("the read is tried again through an open Crowdmark tab", async () => {
    const r = await readCrowdmark(settings, LEARN, { relay: tabWorks, now: NOW });
    assert.equal(r.status, "ok");
    assert.equal(r.report.via, "tab");
    assert.equal(r.items.length, 1);
    assert.ok(r.okCourseIds.has("99001"), "marked read, so a later merge may drop what is gone");
  });

  test("with no Crowdmark tab open, it is signed out and nothing is dropped", async () => {
    const r = await readCrowdmark(settings, LEARN, { relay: noTab, now: NOW });
    assert.equal(r.status, "signed-out");
    assert.equal(r.items.length, 0);
    assert.equal(r.okCourseIds.size, 0);
  });
});

describe("Crowdmark is down", () => {
  before(() => serve(() => down()));

  test("the tab is not tried, since an outage reads the same from either place", async () => {
    let relayCalls = 0;
    const r = await readCrowdmark(settings, LEARN, {
      relay: async (p) => { relayCalls++; return tabWorks(p); },
      now: NOW,
    });
    assert.equal(r.status, "unreachable");
    assert.equal(relayCalls, 0);
  });
});

describe("the check before a reminder goes out", () => {
  before(() => serve(() => unauthorized()));

  test("it falls back to a tab too", async () => {
    const seen = await crowdmarkSubmitted(settings, { id: "cm:aaaa-bbbb" }, async () => ({
      status: 200,
      type: "application/json",
      json: { data: { attributes: { "submitted-at": "2026-10-09T20:00:00Z" } } },
    }));
    assert.deepEqual(seen, { submitted: true, at: "2026-10-09T20:00:00Z" });
  });

  test("with no answer it gives none, so the reminder still goes out", async () => {
    assert.equal(await crowdmarkSubmitted(settings, { id: "cm:aaaa-bbbb" }, noTab), null);
  });
});
