import test from "node:test";
import assert from "node:assert/strict";

import { GRAPH_BASE, OUTLOOK_CALENDAR_NAME } from "../extension/src/calendar/outlook-config.js";
import { WATNOW_PROP, outlookEvent, outlookFingerprint, transactionIdFor } from "../extension/src/calendar/outlook-model.js";
import { outlookApi } from "../extension/src/calendar/outlook-api.js";

const course = { id: "c1", code: "CS 135", name: "Designing Functional Programs" };
const item = (over = {}) => ({ id: "i1", courseId: "c1", title: "Assignment 1", dueAt: "2026-10-15T23:59:00Z", url: "https://learn.uwaterloo.ca/a1", status: "open", ...over });

// Fake fetch: records every call and answers from a queue of responses
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
    const next = queue.shift() ?? { status: 200, json: {} };
    if (next.throw) throw next.throw;
    const headers = new Headers(next.headers || {});
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers,
      json: async () => {
        if (next.json === undefined) throw new SyntaxError("no body");
        return next.json;
      },
    };
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("WATNOW_PROP is a named String property with a GUID namespace", () => {
  assert.match(WATNOW_PROP, /^String \{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\} Name watnowKey$/);
});

test("outlookEvent builds an open deadline", () => {
  const ev = outlookEvent(item(), course, "uwaterloo:i1");
  assert.equal(ev.subject, "CS 135 · Assignment 1 due");
  assert.deepEqual(ev.body, {
    contentType: "text",
    content: "Open\nCS 135 · Designing Functional Programs\n\nhttps://learn.uwaterloo.ca/a1\n\nSynced by WATnow. Deadline changes on your course site update this event.",
  });
  assert.deepEqual(ev.start, { dateTime: "2026-10-15T23:59:00", timeZone: "UTC" });
  assert.deepEqual(ev.end, { dateTime: "2026-10-16T00:00:00", timeZone: "UTC" });
  assert.equal(ev.showAs, "free");
  assert.equal(ev.isReminderOn, false);
  assert.deepEqual(ev.singleValueExtendedProperties, [{ id: WATNOW_PROP, value: "uwaterloo:i1" }]);
  assert.equal(ev.transactionId, undefined);
});

test("outlookEvent converts a non-UTC due time to UTC", () => {
  const ev = outlookEvent(item({ dueAt: "2026-10-15T23:59:00-04:00" }), course, "k");
  assert.deepEqual(ev.start, { dateTime: "2026-10-16T03:59:00", timeZone: "UTC" });
});

test("outlookEvent marks submitted and done items with a checkmark", () => {
  const submitted = outlookEvent(item({ status: "submitted" }), course, "k");
  assert.equal(submitted.subject, "✓ CS 135 · Assignment 1 due");
  assert.ok(submitted.body.content.startsWith("Submitted\n"));

  const done = outlookEvent(item({ status: "done" }), { id: "c1", code: "CS 135" }, "k");
  assert.equal(done.subject, "✓ CS 135 · Assignment 1 due");
  assert.ok(done.body.content.startsWith("Checked off\nCS 135\n\n"));
});

test("outlookFingerprint is stable and changes when the due time moves", () => {
  const a = outlookFingerprint(outlookEvent(item(), course, "k"));
  assert.equal(a, outlookFingerprint(outlookEvent(item(), course, "k")));
  // The tag isn't shown, so a different key alone doesn't count as a change
  assert.equal(a, outlookFingerprint(outlookEvent(item(), course, "other")));
  assert.notEqual(a, outlookFingerprint(outlookEvent(item({ dueAt: "2026-10-16T23:59:00Z" }), course, "k")));
  assert.notEqual(a, outlookFingerprint(outlookEvent(item({ status: "done" }), course, "k")));
  assert.notEqual(a, outlookFingerprint(outlookEvent(item({ url: "https://x" }), course, "k")));
});

test("transactionIdFor is deterministic, GUID-shaped and key-specific", () => {
  const id = transactionIdFor("uwaterloo:i1");
  assert.equal(id, transactionIdFor("uwaterloo:i1"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(id, transactionIdFor("uwaterloo:i2"));
  const many = new Set(Array.from({ length: 2000 }, (_, i) => transactionIdFor(`uwaterloo:${i}`)));
  assert.equal(many.size, 2000);
});

test("requests send bearer token, JSON content type and a timeout", async () => {
  const calls = fakeFetch([{ status: 200, json: { id: "u1", displayName: "Sam" } }]);
  const me = await outlookApi("tok").me();
  assert.equal(me.displayName, "Sam");
  assert.equal(calls[0].url, `${GRAPH_BASE}/me?$select=displayName,mail,userPrincipalName,id`);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("listCalendars follows @odata.nextLink and calls the guard per page", async () => {
  const next = `${GRAPH_BASE}/me/calendars?$select=id,name&$skip=10`;
  const calls = fakeFetch([
    { status: 200, json: { value: [{ id: "a", name: "Calendar" }], "@odata.nextLink": next } },
    { status: 200, json: { value: [{ id: "b", name: "WATnow" }] } },
  ]);
  let guards = 0;
  const list = await outlookApi("tok", async () => { guards++; }).listCalendars();
  assert.deepEqual(list.map((c) => c.id), ["a", "b"]);
  assert.equal(calls[0].url, `${GRAPH_BASE}/me/calendars?$select=id,name`);
  assert.equal(calls[1].url, next);
  assert.equal(guards, 2);
});

test("createCalendar, getCalendar, createEvent, patchEvent use the right paths", async () => {
  const calls = fakeFetch([
    { status: 201, json: { id: "cal/1", name: "WATnow" } },
    { status: 200, json: { id: "cal/1" } },
    { status: 201, json: { id: "ev1" } },
    { status: 200, json: { id: "ev1" } },
  ]);
  const api = outlookApi("tok");
  await api.createCalendar();
  await api.getCalendar("cal/1");
  const ev = outlookEvent(item(), course, "k");
  await api.createEvent("cal/1", ev);
  await api.patchEvent("ev=1", { subject: "x" });

  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${GRAPH_BASE}/me/calendars`);
  assert.deepEqual(calls[0].body, { name: OUTLOOK_CALENDAR_NAME });
  assert.equal(calls[1].url, `${GRAPH_BASE}/me/calendars/cal%2F1`);
  assert.equal(calls[2].method, "POST");
  assert.equal(calls[2].url, `${GRAPH_BASE}/me/calendars/cal%2F1/events`);
  assert.deepEqual(calls[2].body, ev);
  assert.equal(calls[3].method, "PATCH");
  assert.equal(calls[3].url, `${GRAPH_BASE}/me/events/ev%3D1`);
});

test("findEventByKey searches the mailbox by tag, selects only real fields, escapes quotes, and matches the key exactly", async () => {
  const tagged = (id, value, calendarId = "cal1") => ({ id, calendarId, singleValueExtendedProperties: [{ id: WATNOW_PROP, value }] });
  const calls = fakeFetch([
    // Graph matches the value ignoring case, so a near-miss can come back first.
    { status: 200, json: { value: [tagged("evCase", "UWATERLOO:O'BRIEN"), tagged("ev1", "uwaterloo:o'brien")] } },
    { status: 200, json: { value: [] } },
  ]);
  const api = outlookApi("tok");
  assert.equal((await api.findEventByKey("cal1", "uwaterloo:o'brien")).id, "ev1");
  assert.equal(await api.findEventByKey("cal1", "uwaterloo:none"), null);

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1.0/me/events", "the documented path for this filter");
  assert.equal(
    url.searchParams.get("$filter"),
    `singleValueExtendedProperties/Any(ep: ep/id eq '${WATNOW_PROP}' and ep/value eq 'uwaterloo:o''brien')`,
  );
  assert.equal(url.searchParams.get("$expand"), `singleValueExtendedProperties($filter=id eq '${WATNOW_PROP}')`);
  // Events have no calendarId property: selecting one makes Graph refuse the request.
  assert.equal(url.searchParams.get("$select"), "id");
  // Spaces, colons and slashes are percent-encoded in the raw URL
  assert.ok(!calls[0].url.split("?")[1].includes(" "));
  assert.ok(calls[0].url.includes("singleValueExtendedProperties%2FAny(ep%3A%20ep%2Fid%20eq%20"));
});

test("guard runs before each request and can stop it", async () => {
  const calls = fakeFetch([{ status: 200, json: {} }]);
  const order = [];
  const api = outlookApi("tok", async () => { order.push(`guard${calls.length}`); });
  await api.getCalendar("c");
  assert.deepEqual(order, ["guard0"]);

  const blocked = outlookApi("tok", async () => { throw new Error("account changed"); });
  await assert.rejects(blocked.deleteEvent("e"), /account changed/);
  assert.equal(calls.length, 1);
});

test("204 resolves to null", async () => {
  fakeFetch([{ status: 204 }]);
  assert.equal(await outlookApi("tok").deleteEvent("e1"), null);
});

test("deleteEvent treats 404 and 410 as already gone", async () => {
  const calls = fakeFetch([{ status: 404, json: { error: { code: "ErrorItemNotFound" } } }, { status: 410, json: {} }]);
  const api = outlookApi("tok");
  assert.equal(await api.deleteEvent("e1"), null);
  assert.equal(await api.deleteEvent("e2"), null);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, `${GRAPH_BASE}/me/events/e1`);
});

test("404 outside delete is a non-retryable error", async () => {
  fakeFetch([{ status: 404, json: { error: { code: "ErrorItemNotFound" } } }]);
  await assert.rejects(outlookApi("tok").getCalendar("gone"), (e) => e.code === "api" && e.retry === false && e.status === 404 && e.graphCode === "ErrorItemNotFound");
});

test("401 asks for a token refresh and retries", async () => {
  fakeFetch([{ status: 401, json: {} }]);
  await assert.rejects(outlookApi("tok").me(), (e) => e.code === "token" && e.retry === true && e.message === "Outlook sign-in expired. Retrying shortly.");
});

test("429 is retryable and carries Retry-After", async () => {
  fakeFetch([{ status: 429, headers: { "Retry-After": "10" }, json: { error: { code: "TooManyRequests" } } }]);
  await assert.rejects(outlookApi("tok").me(), (e) =>
    e.code === "api" && e.retry === true && e.status === 429 && e.retryAfter === 10 && e.message === "Outlook is busy. Your calendar changes are queued.");
});

test("500 is retryable with a default wait of 60 seconds", async () => {
  fakeFetch([{ status: 500, json: {} }]);
  await assert.rejects(outlookApi("tok").me(), (e) => e.code === "api" && e.retry === true && e.status === 500 && e.retryAfter === 60);
});

test("503 with an HTTP-date Retry-After converts to seconds", async () => {
  fakeFetch([{ status: 503, headers: { "Retry-After": new Date(Date.now() + 30000).toUTCString() } }]);
  await assert.rejects(outlookApi("tok").me(), (e) => e.retry === true && e.retryAfter > 25 && e.retryAfter <= 30);
});

test("403 is not retryable and keeps Graph's error code", async () => {
  fakeFetch([{ status: 403, json: { error: { code: "ErrorAccessDenied", message: "Access is denied." } } }]);
  await assert.rejects(outlookApi("tok").createEvent("c", {}), (e) =>
    e.code === "api" && e.retry === false && e.status === 403 && e.graphCode === "ErrorAccessDenied" &&
    e.message === "Outlook couldn't update the WATnow calendar. Check its access and reconnect.");
});

test("network failure is a retryable network error", async () => {
  fakeFetch([{ throw: new TypeError("fetch failed") }]);
  await assert.rejects(outlookApi("tok").listCalendars(), (e) =>
    e.code === "network" && e.retry === true && e.message === "Couldn't reach Outlook. Your calendar changes are queued.");
});
