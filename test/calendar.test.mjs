import test from "node:test";
import assert from "node:assert/strict";

// Mock minimal chrome globals before importing extension modules
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ permissions: ["identity"], host_permissions: [] }),
    id: "test-extension-id",
    getURL: (path = "") => `chrome-extension://test-extension-id/${path}`,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  identity: {
    getRedirectURL: (name = "") => `https://test-extension-id.chromiumapp.org/${name}`,
    getAuthToken: async () => ({ token: "mock-token", grantedScopes: [] }),
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
    launchWebAuthFlow: async () => {},
  },
  alarms: {
    create: async () => {},
    clear: async () => {},
  },
};

import { GOOGLE_SCOPES, googleConfigured } from "../extension/src/calendar/config.js";
import { deadlineKey, eventIdFor, deadlineToEvent, eventFingerprint, calendarPlan } from "../extension/src/calendar/event-model.js";

test("OAuth scopes are non-sensitive", () => {
  assert.ok(!GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/calendar.calendarlist.readonly"));
  assert.ok(GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/calendar.app.created"));
  assert.ok(GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/userinfo.email"));
});

test("googleConfigured returns false when client ID is blank", () => {
  assert.equal(googleConfigured(), false);
});

test("deadlineKey derives stable school and item key", () => {
  const item = { id: "dropbox-12345" };
  assert.equal(deadlineKey("uwaterloo", item), "uwaterloo:dropbox-12345");
});

test("eventIdFor generates valid Google event ID with hex prefix", async () => {
  const key = "uwaterloo:item-1";
  const id0 = await eventIdFor(key, 0);
  assert.match(id0, /^a[0-9a-f]{64}$/);

  // Version 1 produces a different ID to bypass cancelled graveyard
  const id1 = await eventIdFor(key, 1);
  assert.match(id1, /^a[0-9a-f]{64}$/);
  assert.notEqual(id0, id1);
});

test("deadlineToEvent marks completed/submitted items with checkmark", () => {
  const course = { id: "c1", code: "CS 135", name: "Designing Functional Programs" };
  const itemOpen = { id: "i1", title: "Assignment 1", dueAt: "2026-10-15T23:59:00Z", status: "open" };
  const evOpen = deadlineToEvent(itemOpen, course, "uwaterloo:i1");
  assert.equal(evOpen.summary, "CS 135 · Assignment 1 due");
  assert.ok(evOpen.description.includes("Open"));

  const itemSubmitted = { id: "i1", title: "Assignment 1", dueAt: "2026-10-15T23:59:00Z", status: "submitted" };
  const evSubmitted = deadlineToEvent(itemSubmitted, course, "uwaterloo:i1");
  assert.equal(evSubmitted.summary, "✓ CS 135 · Assignment 1 due");
  assert.ok(evSubmitted.description.includes("Submitted"));

  const itemDone = { id: "i1", title: "Assignment 1", dueAt: "2026-10-15T23:59:00Z", status: "done" };
  const evDone = deadlineToEvent(itemDone, course, "uwaterloo:i1");
  assert.equal(evDone.summary, "✓ CS 135 · Assignment 1 due");
  assert.ok(evDone.description.includes("Checked off"));
});

test("calendarPlan: Bug 1 - Fake hide and republish recreates event", async () => {
  const school = "uwaterloo";
  const course = { id: "c1", code: "MATH 135" };
  const item = { id: "a1", courseId: "c1", title: "Assignment 1", dueAt: new Date(Date.now() + 86400000).toISOString(), status: "open" };
  const records = {};

  // Step 1: Initial scan with assignment
  const state1 = { courses: [course], items: [item] };
  const plan1 = await calendarPlan(state1, school, records);
  assert.equal(plan1.length, 1);
  assert.equal(plan1[0].remove, undefined);
  assert.equal(plan1[0].key, "uwaterloo:a1");

  // Save the synced event
  records[plan1[0].id] = {
    id: plan1[0].id,
    key: plan1[0].key,
    version: 0,
    fingerprint: plan1[0].fingerprint,
    school,
    courseId: "c1",
  };

  // Step 2: Instructor hides the assignment (item disappears from state)
  const state2 = { courses: [course], items: [] };
  const plan2 = await calendarPlan(state2, school, records);
  assert.equal(plan2.length, 1);
  assert.equal(plan2[0].remove, true);

  // Removal executed in sync - record marked removed (NOT deleted: true!)
  records[plan1[0].id] = {
    id: plan1[0].id,
    key: plan1[0].key,
    version: 1,
    removed: true,
    school,
    courseId: "c1",
  };

  // Step 3: Instructor unhides / republishes the assignment!
  const state3 = { courses: [course], items: [item] };
  const plan3 = await calendarPlan(state3, school, records);
  assert.equal(plan3.length, 1, "Republished item MUST be planned for insertion!");
  assert.equal(plan3[0].remove, undefined);
  assert.equal(plan3[0].version, 1);
  assert.notEqual(plan3[0].id, plan1[0].id, "New ID with bumped version prevents Google 409 conflict!");
});

test("calendarPlan: User deleted event in Google Calendar stays deleted", async () => {
  const school = "uwaterloo";
  const course = { id: "c1", code: "MATH 135" };
  const item = { id: "a1", courseId: "c1", title: "Assignment 1", dueAt: new Date(Date.now() + 86400000).toISOString(), status: "open" };

  // When user deleted in Google Calendar, record has deleted: true
  const baseId = await eventIdFor("uwaterloo:a1", 0);
  const records = {
    [baseId]: {
      id: baseId,
      key: "uwaterloo:a1",
      deleted: true,
      school,
      courseId: "c1",
    },
  };

  const state = { courses: [course], items: [item] };
  const plan = await calendarPlan(state, school, records);
  assert.equal(plan.length, 0, "User-deleted event in Google must not be recreated");
});

test("calendarPlan: Bug 2 - End of term does not wipe events from dropped courses", async () => {
  const school = "uwaterloo";
  const pastCourse = { id: "cs135", code: "CS 135" };
  const currentCourse = { id: "cs136", code: "CS 136" };

  const id1 = await eventIdFor("uwaterloo:old-a1", 0);
  const records = {
    [id1]: {
      id: id1,
      key: "uwaterloo:old-a1",
      fingerprint: "fp1",
      school,
      courseId: "cs135",
      version: 0,
    },
  };

  // Term ended: CS 135 is no longer in state.courses. Only CS 136 is active.
  const state = {
    courses: [currentCourse],
    items: [],
  };

  const plan = await calendarPlan(state, school, records);
  assert.equal(plan.length, 0, "End of term course removal must NOT plan event deletions!");
});

test("calendarPlan: When calendar is deleted in Google and recreated, reset records re-syncs all items", async () => {
  const school = "uwaterloo";
  const course = { id: "cs135", code: "CS 135" };
  const item = { id: "a1", courseId: "cs135", title: "Assignment 1", dueAt: new Date(Date.now() + 86400000).toISOString(), status: "open" };

  // When calendar was deleted in Google, events record is reset to {}
  const records = {};
  const state = { courses: [course], items: [item] };

  const plan = await calendarPlan(state, school, records);
  assert.equal(plan.length, 1, "All deadlines must be re-synced to the new calendar");
  assert.equal(plan[0].key, "uwaterloo:a1");
});
