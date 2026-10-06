import test from "node:test";
import assert from "node:assert/strict";

// In-memory mock storage and Google Calendar REST API mock
const mockStorage = {
  local: new Map(),
  session: new Map(),
};

const mockGoogleServer = {
  calendars: new Map(),
  events: new Map(), // calendarId -> Map(eventId -> event)
  nextCalendarId: 1,
};

// Global chrome mock
globalThis.chrome = {
  runtime: {
    id: "watnow-test-ext-id",
    getURL: (p = "") => `chrome-extension://watnow-test-ext-id/${p}`,
    getManifest: () => ({ oauth2: { client_id: "mock-client-id.apps.googleusercontent.com" }, permissions: ["identity"] }),
    sendMessage: async () => ({ ok: true }),
  },
  storage: {
    local: {
      get: async (key) => {
        if (!key) return Object.fromEntries(mockStorage.local);
        if (typeof key === "string") return { [key]: mockStorage.local.get(key) };
        return {};
      },
      set: async (items) => {
        for (const [k, v] of Object.entries(items)) mockStorage.local.set(k, v);
      },
      clear: async () => mockStorage.local.clear(),
    },
    session: {
      get: async (key) => {
        if (!key) return Object.fromEntries(mockStorage.session);
        if (typeof key === "string") return { [key]: mockStorage.session.get(key) };
        return {};
      },
      set: async (items) => {
        for (const [k, v] of Object.entries(items)) mockStorage.session.set(k, v);
      },
      remove: async (key) => mockStorage.session.delete(key),
    },
  },
  identity: {
    getRedirectURL: (name = "") => `https://watnow-test-ext-id.chromiumapp.org/${name}`,
    getAuthToken: async () => ({ token: "mock-native-token", grantedScopes: ["https://www.googleapis.com/auth/calendar.app.created", "https://www.googleapis.com/auth/userinfo.email"] }),
    clearAllCachedAuthTokens: async () => {},
    removeCachedAuthToken: async () => {},
    launchWebAuthFlow: async ({ url, interactive }) => {
      // Simulate Google redirecting back with auth token
      const u = new URL(url);
      const state = u.searchParams.get("state");
      const redirect = u.searchParams.get("redirect_uri");
      return `${redirect}#access_token=mock-access-token-12345&token_type=Bearer&expires_in=3600&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.app.created+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email&state=${state}`;
    },
  },
  alarms: {
    create: async () => {},
    clear: async () => {},
  },
};

// Global fetch mock to simulate Google Calendar v3 and Userinfo REST APIs
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const path = u.pathname;
  const method = opts.method || "GET";

  // Google Userinfo
  if (path === "/oauth2/v3/userinfo") {
    return {
      ok: true,
      status: 200,
      json: async () => ({ sub: "google-user-789", email: "student@uwaterloo.ca", email_verified: true }),
    };
  }

  // Google Calendar v3: /calendar/v3/calendars
  if (path === "/calendar/v3/calendars" && method === "POST") {
    const body = JSON.parse(opts.body);
    const id = `cal_${mockGoogleServer.nextCalendarId++}@group.calendar.google.com`;
    const cal = { id, summary: body.summary, description: body.description };
    mockGoogleServer.calendars.set(id, cal);
    mockGoogleServer.events.set(id, new Map());
    return { ok: true, status: 200, json: async () => cal };
  }

  // Google Calendar v3: /calendar/v3/calendars/{calendarId}
  const calMatch = path.match(/^\/calendar\/v3\/calendars\/([^/]+)$/);
  if (calMatch) {
    const calId = decodeURIComponent(calMatch[1]);
    const cal = mockGoogleServer.calendars.get(calId);
    if (!cal) return { ok: false, status: 404, json: async () => ({ error: { message: "Not Found" } }) };
    return { ok: true, status: 200, json: async () => cal };
  }

  // Google Calendar v3: /calendar/v3/calendars/{calendarId}/events
  const eventsMatch = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
  if (eventsMatch && method === "POST") {
    const calId = decodeURIComponent(eventsMatch[1]);
    const calEvents = mockGoogleServer.events.get(calId) || new Map();
    const body = JSON.parse(opts.body);
    if (calEvents.has(body.id)) {
      const existing = calEvents.get(body.id);
      if (existing.status === "cancelled") {
        return { ok: false, status: 409, json: async () => ({ error: { message: "Conflict: Event ID was cancelled" } }) };
      }
    }
    calEvents.set(body.id, { ...body, status: "confirmed" });
    mockGoogleServer.events.set(calId, calEvents);
    return { ok: true, status: 200, json: async () => body };
  }

  // Google Calendar v3: /calendar/v3/calendars/{calendarId}/events/{eventId}
  const eventMatch = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/);
  if (eventMatch) {
    const calId = decodeURIComponent(eventMatch[1]);
    const eventId = decodeURIComponent(eventMatch[2]);
    const calEvents = mockGoogleServer.events.get(calId);
    const existing = calEvents?.get(eventId);

    if (method === "GET") {
      if (!existing) return { ok: false, status: 404, json: async () => ({ error: { message: "Event not found" } }) };
      return { ok: true, status: 200, json: async () => existing };
    }
    if (method === "PATCH") {
      if (!existing) return { ok: false, status: 404, json: async () => ({ error: { message: "Event not found" } }) };
      const body = JSON.parse(opts.body);
      const updated = { ...existing, ...body };
      calEvents.set(eventId, updated);
      return { ok: true, status: 200, json: async () => updated };
    }
    if (method === "DELETE") {
      if (!existing) return { ok: false, status: 404, json: async () => ({ error: { message: "Event not found" } }) };
      calEvents.set(eventId, { ...existing, status: "cancelled" });
      return { ok: true, status: 204 };
    }
  }

  return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
};

// Now import watnow modules
import { connectCalendar, runCalendarSync, stopCalendarSync } from "../extension/src/calendar/calendar-sync.js";
import { getCalendarState, getState, getSettings } from "../extension/src/core/store.js";

test("Full End-to-End Simulation: Connect, Sync, Move, Check-off, Republish, End-of-Term, Disconnect", async () => {
  // 1. Initial State setup in WATnow
  mockStorage.local.set("settings", { mode: "live", school: "uwaterloo" });
  mockStorage.local.set("state", {
    scan: { status: "done" },
    courses: [{ id: "c1", code: "CS 135", name: "Designing Functional Programs" }],
    items: [
      { id: "a1", courseId: "c1", title: "Assignment 1", dueAt: new Date(Date.now() + 86400000).toISOString(), status: "open" },
      { id: "a2", courseId: "c1", title: "Assignment 2", dueAt: new Date(Date.now() + 172800000).toISOString(), status: "open" },
    ],
  });

  // 2. Connect Calendar
  const connResult = await connectCalendar();
  assert.equal(connResult.ok, true, "connectCalendar should succeed");

  let calState = await getCalendarState();
  assert.equal(calState.enabled, true, "Calendar should be enabled");
  assert.equal(calState.account.email, "student@uwaterloo.ca", "Email should match");

  // 3. Initial Sync
  await runCalendarSync();

  calState = await getCalendarState();
  const accountRecord = calState.accounts[calState.account.id];
  assert.ok(accountRecord.calendarId, "WATNOW secondary calendar should be created");
  assert.equal(mockGoogleServer.calendars.has(accountRecord.calendarId), true, "Google calendar exists in server");

  const serverEvents = mockGoogleServer.events.get(accountRecord.calendarId);
  assert.equal(serverEvents.size, 2, "2 events should be inserted into Google Calendar");

  // 4. Update: Assignment 1 due date pushed (moved)
  const movedDate = new Date(Date.now() + 200000000).toISOString();
  mockStorage.local.set("state", {
    scan: { status: "done" },
    courses: [{ id: "c1", code: "CS 135", name: "Designing Functional Programs" }],
    items: [
      { id: "a1", courseId: "c1", title: "Assignment 1", dueAt: movedDate, status: "open" },
      { id: "a2", courseId: "c1", title: "Assignment 2", dueAt: new Date(Date.now() + 172800000).toISOString(), status: "open" },
    ],
  });
  calState.pending = true;
  mockStorage.local.set("calendar", calState);

  await runCalendarSync();

  // Verify event 1 in Google Calendar has updated start time
  const event1Key = Object.keys(accountRecord.events)[0];
  const gEvent1 = serverEvents.get(event1Key);
  assert.equal(gEvent1.start.dateTime, movedDate, "Google Calendar event date was updated");

  // 5. Update: Student submits Assignment 1 (check mark ✓)
  mockStorage.local.set("state", {
    scan: { status: "done" },
    courses: [{ id: "c1", code: "CS 135", name: "Designing Functional Programs" }],
    items: [
      { id: "a1", courseId: "c1", title: "Assignment 1", dueAt: movedDate, status: "submitted" },
      { id: "a2", courseId: "c1", title: "Assignment 2", dueAt: new Date(Date.now() + 172800000).toISOString(), status: "open" },
    ],
  });
  calState.pending = true;
  mockStorage.local.set("calendar", calState);

  await runCalendarSync();

  const gEvent1Submitted = serverEvents.get(event1Key);
  assert.ok(gEvent1Submitted.summary.startsWith("✓ "), "Submitted event summary starts with check mark");
  assert.ok(gEvent1Submitted.description.includes("Submitted"), "Description has Submitted status");

  // 6. Bug 1 Test: Instructor hides Assignment 2 to edit it
  mockStorage.local.set("state", {
    scan: { status: "done" },
    courses: [{ id: "c1", code: "CS 135", name: "Designing Functional Programs" }],
    items: [
      { id: "a1", courseId: "c1", title: "Assignment 1", dueAt: movedDate, status: "submitted" },
      // Assignment 2 temporarily missing
    ],
  });
  calState.pending = true;
  mockStorage.local.set("calendar", calState);

  await runCalendarSync();

  // Assignment 2 event should be removed from Google Calendar
  const event2Key = Object.keys(accountRecord.events)[1];
  const gEvent2Removed = serverEvents.get(event2Key);
  assert.equal(gEvent2Removed.status, "cancelled", "Event 2 was removed (cancelled in Google)");

  // Instructor republishes Assignment 2!
  mockStorage.local.set("state", {
    scan: { status: "done" },
    courses: [{ id: "c1", code: "CS 135", name: "Designing Functional Programs" }],
    items: [
      { id: "a1", courseId: "c1", title: "Assignment 1", dueAt: movedDate, status: "submitted" },
      { id: "a2", courseId: "c1", title: "Assignment 2", dueAt: new Date(Date.now() + 172800000).toISOString(), status: "open" },
    ],
  });
  calState.pending = true;
  mockStorage.local.set("calendar", calState);

  await runCalendarSync();

  // Verify Assignment 2 is recreated with a new ID, avoiding 409 conflict
  calState = await getCalendarState();
  const updatedRecords = calState.accounts[calState.account.id].events;
  const activeEvents = Array.from(serverEvents.values()).filter((e) => e.status === "confirmed");
  assert.equal(activeEvents.length, 2, "Both Assignment 1 and republished Assignment 2 are active in Google Calendar!");

  // 7. Bug 2 Test: End of term (Course CS 135 dropped)
  // Term ends: new term courses loaded
  mockStorage.local.set("state", {
    scan: { status: "done" },
    courses: [{ id: "c2", code: "CS 136", name: "Elementary Algorithm Design" }],
    items: [],
  });
  calState.pending = true;
  mockStorage.local.set("calendar", calState);

  await runCalendarSync();

  // Past events must NOT be deleted!
  const eventsAfterTermEnd = Array.from(serverEvents.values()).filter((e) => e.status === "confirmed");
  assert.equal(eventsAfterTermEnd.length, 2, "End of term does not delete past course events from Google Calendar!");

  // 8. Disconnect: stopCalendarSync({ disconnect: true })
  await stopCalendarSync({ disconnect: true });
  calState = await getCalendarState();
  assert.equal(calState.enabled, false, "Calendar is disabled");
  assert.equal(calState.account, null, "Account is cleared");

  // Google events remain intact
  const eventsAfterDisconnect = Array.from(serverEvents.values()).filter((e) => e.status === "confirmed");
  assert.equal(eventsAfterDisconnect.length, 2, "Existing events stay in Google Calendar after disconnect");
});
