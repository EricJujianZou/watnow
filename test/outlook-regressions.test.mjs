// Outlook sync bugs found in review, each reproduced first and kept here so they stay fixed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const local = {};
const session = {};
const alarms = {};
let permitted = true;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const area = (m) => ({
  get: async (k) => {
    await null;
    if (k == null) return clone(m);
    const o = {};
    for (const x of [].concat(k)) if (x in m) o[x] = clone(m[x]);
    return o;
  },
  set: async (o) => {
    await null;
    if (m === local && "outlookAuth" in o && holdAuthWrite) await holdAuthWrite;
    for (const [k, v] of Object.entries(o)) m[k] = clone(v);
  },
  remove: async (k) => {
    await null;
    for (const x of [].concat(k)) delete m[x];
  },
});
let signInDelay = 0;
let holdAuthWrite = null;
globalThis.chrome = {
  storage: { local: area(local), session: area(session) },
  runtime: { id: "abc", getURL: (p = "") => "chrome-extension://abc/" + p, getManifest: () => ({}) },
  alarms: { create: async (n, o) => { alarms[n] = o; }, clear: async (n) => { delete alarms[n]; return true; } },
  permissions: { contains: async () => permitted },
  declarativeNetRequest: { updateSessionRules: async () => {} },
  identity: {
    getRedirectURL: (p = "") => "https://abc.chromiumapp.org/" + p,
    // Microsoft's sign-in window: answers with a code and the state it was given.
    launchWebAuthFlow: async ({ url }) => {
      await new Promise((r) => setTimeout(r, signInDelay));
      const state = new URL(url).searchParams.get("state");
      return `https://abc.chromiumapp.org/outlook?code=the-code&state=${state}`;
    },
  },
};

const auth = await import("../extension/src/calendar/outlook-auth.js");
const sync = await import("../extension/src/calendar/outlook-sync.js");

const json = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
const ACCOUNT = { id: "acct1", displayName: "Sam", mail: "sam@outlook.com" };
let created;
let calendars = [];
let calendarCount = 0;
let refuse = () => false;
let tokenDelay = 0;
function fakeMicrosoft() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || "GET";
    if (u.hostname === "login.microsoftonline.com") {
      await new Promise((r) => setTimeout(r, tokenDelay));
      return json(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "Calendars.ReadWrite User.Read offline_access" });
    }
    const p = u.pathname.replace("/v1.0", "");
    if (p === "/me") return json(200, ACCOUNT);
    if (p === "/me/calendars" && method === "GET") return json(200, { value: [] });
    if (p === "/me/calendars" && method === "POST") {
      calendars.push(`cal${++calendarCount}`);
      return json(201, { id: calendars.at(-1), name: "WATnow" });
    }
    const one = p.match(/^\/me\/calendars\/([^/]+)$/);
    if (one) return calendars.includes(one[1]) ? json(200, { id: one[1] }) : json(404, {});
    if (p === "/me/events" && method === "GET") return json(200, { value: [] });
    if (p.endsWith("/events") && method === "POST") {
      const body = JSON.parse(opts.body);
      if (refuse(body)) return json(409, { error: { code: "ErrorIrresolvableConflict", message: "conflict" } });
      created.push(body.subject);
      return json(201, { id: `ev${created.length}` });
    }
    return json(404, {});
  };
}

const course = { id: "ou1", code: "MATH 135", name: "Algebra" };
const due = (n) => new Date(Date.now() + n * 864e5).toISOString();
const item = (id, n) => ({ id, courseId: "ou1", kind: "dropbox", category: "assignment", title: id, dueAt: due(n), status: "open", url: "" });

beforeEach(() => {
  for (const m of [local, session, alarms]) for (const k of Object.keys(m)) delete m[k];
  auth.__testing.reset();
  auth.__testing.setClientId("test-client");
  permitted = true;
  signInDelay = 0;
  tokenDelay = 0;
  created = [];
  calendars = [];
  calendarCount = 0;
  holdAuthWrite = null;
  refuse = () => false;
  local.settings = { mode: "live", school: "uwaterloo", reminders: { leads: {}, offTypes: [], mutedCourses: [] } };
  local.state = { scan: { status: "done" }, syncing: false, courses: [course], items: [item("a", 3), item("bad", 4), item("c", 5)] };
  fakeMicrosoft();
});

const connected = async () => {
  const r = await sync.connectOutlookCalendar("sam@outlook.com");
  await sync.runOutlookSync();
  return r;
};

test("one deadline Outlook keeps refusing doesn't stop the rest, or anything added later", async () => {
  refuse = (b) => b.subject.includes("bad");
  await connected();
  let s = await sync.getOutlookState();
  assert.equal(s.status, "ready");
  assert.deepEqual(created, ["MATH 135 · a due", "MATH 135 · c due"]);
  assert.equal(s.skipped, 1, "the refused one is counted for the settings page");

  local.state.items.push(item("new", 6));
  await sync.requestOutlookSync();
  await sync.runOutlookSync();
  s = await sync.getOutlookState();
  assert.equal(s.status, "ready");
  assert.ok(created.includes("MATH 135 · new due"), "a deadline added later still reaches Outlook");
  assert.equal(created.filter((x) => x.includes("bad")).length, 0, "the refused one isn't hammered every sync");

  // Once it changes, it's tried again.
  refuse = () => false;
  local.state.items.find((i) => i.id === "bad").title = "bad (renamed)";
  await sync.requestOutlookSync();
  await sync.runOutlookSync();
  assert.ok(created.includes("MATH 135 · bad (renamed) due"));
});

test("two Connect clicks close together: the sign-in that finishes is kept", async () => {
  signInDelay = 50;
  const [first, second] = await Promise.all([sync.connectOutlookCalendar("sam@outlook.com"), sync.connectOutlookCalendar("sam@outlook.com")]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, false);
  assert.match(second.reason, /already open/);
  const s = await sync.getOutlookState();
  assert.equal(s.enabled, true);
  assert.equal(s.account.id, "acct1");
});

test("access to Microsoft's sign-in page taken back: Sign in again, not a dead end", async () => {
  await connected();
  permitted = false;
  await auth.invalidateOutlookToken();
  local.state.items.push(item("new", 6));
  await sync.requestOutlookSync();
  await sync.runOutlookSync();
  const s = await sync.getOutlookState();
  assert.equal(s.status, "reconnect", "the settings page offers Sign in again, which asks for access");
  assert.match(s.error, /Microsoft's sign-in page/);
});

test("disconnecting while a token refresh is mid-write keeps nothing", async () => {
  await connected();
  await auth.invalidateOutlookToken();
  let release;
  holdAuthWrite = new Promise((r) => (release = r));
  const refreshing = auth.getOutlookToken({ id: "acct1" }).catch((e) => e.code);
  await new Promise((r) => setTimeout(r, 20));
  // The refresh is now saving the new sign-in. Disconnect, then let the save finish.
  const disconnecting = auth.disconnectOutlook();
  await new Promise((r) => setTimeout(r, 5));
  holdAuthWrite = null;
  release();
  await disconnecting;
  assert.equal(await refreshing, "cancelled");
  assert.equal(local.outlookAuth, undefined, "no sign-in left on disk");
  assert.equal(session.outlookToken, undefined, "no access token left in the session");
});

test("a new calendar never reuses a transactionId Outlook already saw", async () => {
  const ids = [];
  const base = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || "GET") === "POST" && new URL(url).pathname.endsWith("/events")) ids.push(JSON.parse(opts.body).transactionId);
    return base(url, opts);
  };
  await connected();
  const first = new Set(ids);
  // The student deletes the WATnow calendar; the next sync makes a new one.
  const s = await sync.getOutlookState();
  calendars = calendars.filter((c) => c !== s.calendarId);
  await sync.updateOutlookState((x) => {
    x.pending = true;
    x.revision++;
  });
  ids.length = 0;
  await sync.runOutlookSync();
  assert.ok(ids.length > 0, "events were made again");
  assert.ok(ids.every((id) => !first.has(id)), `reused: ${ids.filter((id) => first.has(id))}`);
  assert.notEqual((await sync.getOutlookState()).calendarId, s.calendarId, "a new calendar");
});

test("a deleted calendar comes back with the checked-off deadlines too", async () => {
  local.state.items.find((i) => i.id === "a").status = "done";
  await connected();
  const before = [...created].sort();
  assert.ok(before.includes("✓ MATH 135 · a due"), "the checked-off one is there from the start");
  // The student deletes the WATnow calendar; the next sync rebuilds it.
  calendars.length = 0;
  created.length = 0;
  await sync.updateOutlookState((x) => {
    x.pending = true;
    x.revision++;
  });
  await sync.runOutlookSync();
  assert.deepEqual([...created].sort(), before, "the rebuilt calendar has the same events");
});
