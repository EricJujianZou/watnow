// The real Outlook sync engine (outlook-sync.js + outlook-api.js + outlook-auth.js)
// against a STRICT fake of Microsoft Graph and the Microsoft token endpoint
// (test/helpers/strict-graph.mjs, every rule cited there). Each scenario checks
// the end state in the fake Outlook mailbox, not just what WATnow thinks it did.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createStrictGraph, TOKEN_URL } from "./helpers/strict-graph.mjs";

// ---------- chrome stubs ----------
const local = new Map();
const session = new Map();
function area(map) {
  return {
    async get(keys) {
      const list = keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}
const alarms = new Map();
const sessionRules = new Map();
let graph;
let launchAccount = "acct-a";
const EXT_ID = "watnow-test-id";

globalThis.chrome = {
  runtime: { id: EXT_ID, getURL: (p = "") => `chrome-extension://${EXT_ID}/${p}`, getManifest: () => ({}) },
  storage: { local: area(local), session: area(session) },
  alarms: {
    async create(name, info) {
      alarms.set(name, { ...info, at: Date.now() });
    },
    async clear(name) {
      return alarms.delete(name);
    },
  },
  identity: {
    getRedirectURL: (p = "") => `https://${EXT_ID}.chromiumapp.org/${p}`,
    launchWebAuthFlow: async ({ url }) => graph.authorize(url, launchAccount),
  },
  declarativeNetRequest: {
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
      graph?.note("dnr", { removeRuleIds, addRules: addRules.map((r) => r.id) });
      for (const id of removeRuleIds) sessionRules.delete(id);
      for (const r of addRules) sessionRules.set(r.id, structuredClone(r));
    },
  },
};
globalThis.fetch = (url, init) => graph.fetch(url, init);

/** Would a browser strip Origin from WATnow's token request? Only if the installed DNR rule covers it. */
function originRuleActive() {
  return [...sessionRules.values()].some(
    (r) =>
      r.action?.type === "modifyHeaders" &&
      r.action.requestHeaders?.some((h) => h.header.toLowerCase() === "origin" && h.operation === "remove") &&
      new RegExp(r.condition?.regexFilter || "^$").test(TOKEN_URL) &&
      r.condition.resourceTypes?.includes("xmlhttprequest") &&
      r.condition.initiatorDomains?.includes(EXT_ID),
  );
}

const sync = await import("../extension/src/calendar/outlook-sync.js");
const auth = await import("../extension/src/calendar/outlook-auth.js");
const { outlookEvent, outlookFingerprint, WATNOW_PROP } = await import("../extension/src/calendar/outlook-model.js");
const { OUTLOOK_CLIENT_ID, OUTLOOK_CALENDAR_NAME } = await import("../extension/src/calendar/outlook-config.js");
const { OUTLOOK_ALARM, runOutlookSync, requestOutlookSync, getOutlookState, emptyOutlookState, outlookKey, stopOutlookSync, connectOutlookCalendar, resumeOutlookSync } = sync;

// The committed config has no client id; the test uses the configured one if present.
const CLIENT = OUTLOOK_CLIENT_ID || "test-client";
const SCHOOL = "uwaterloo";
const DAY = 86400000;
const ACCT_A = { id: "acct-a", mail: "ada@uwaterloo.ca", displayName: "Ada" };
const ACCT_B = { id: "acct-b", mail: "ada.personal@outlook.com", displayName: "Ada P" };

// ---------- the student's list ----------
/** 3 courses x 15 upcoming open deadlines plus one upcoming checked-off each (48 events), plus past ones that must not get events. */
function makeTerm(now = Date.now()) {
  const courses = [
    { id: "c1", code: "CS 246", name: "Object-Oriented Software Development" },
    { id: "c2", code: "MATH 239", name: "Combinatorics" },
    { id: "c3", code: "STAT 230", name: "Probability" },
  ];
  const items = [];
  courses.forEach((c, ci) => {
    for (let n = 0; n < 15; n++) {
      // Ids that stress the OData literal (a quote) and the case-insensitive filter (a case twin).
      const id = ci === 0 && n === 0 ? `${c.id}:quiz:O'Neil` : ci === 0 && n === 1 ? `${c.id}:dropbox:Lab-A` : ci === 0 && n === 2 ? `${c.id}:dropbox:lab-a` : `${c.id}:dropbox:${n}`;
      items.push({ id, courseId: c.id, kind: "dropbox", category: "assignment", title: `A${n} ${c.code}`, dueAt: new Date(now + (n + 1) * DAY + ci * 3600000).toISOString(), status: "open", url: `https://learn.uwaterloo.ca/${c.id}/${n}` });
    }
    items.push({ id: `${c.id}:past`, courseId: c.id, kind: "dropbox", title: "Past", dueAt: new Date(now - 3 * DAY).toISOString(), status: "open", url: "" });
    items.push({ id: `${c.id}:done`, courseId: c.id, kind: "dropbox", title: "Done early", dueAt: new Date(now + 9 * DAY).toISOString(), status: "done", url: "" });
  });
  return { courses, items };
}

async function setList(list, school = SCHOOL) {
  local.set("settings", { mode: "live", school });
  local.set("state", { scan: { status: "done", courses: [] }, syncing: false, courses: list.courses, items: list.items });
}

/** As if the student connected earlier: refresh token saved, sync enabled and owed. */
function seedConnected(acct = ACCT_A) {
  const rt = graph.seedRefreshToken(acct.id);
  const account = { id: acct.id, email: acct.mail, name: acct.displayName };
  local.set("outlookAuth", { refreshToken: rt, account, scope: "Calendars.ReadWrite User.Read offline_access" });
  local.set("outlook", { ...emptyOutlookState(), enabled: true, email: acct.mail, account, status: "ready", pending: true, revision: 1 });
  return rt;
}

/** Run the sync as the alarm would until nothing is owed (or it stops for the student). */
async function drain(max = 30) {
  let runs = 0;
  for (; runs < max; ) {
    await runOutlookSync();
    runs++;
    const s = await getOutlookState();
    if (!s.pending || ["reconnect", "error", "off"].includes(s.status) || !alarms.has(OUTLOOK_ALARM)) break;
  }
  return runs;
}

const keyOf = (ev) => ev.ext.get(WATNOW_PROP);

/** The fake mailbox and WATnow's record agree with each other and with the list. */
async function assertInSync(acctId, list, { extraKeys = [], now = Date.now(), school = SCHOOL } = {}) {
  const o = await getOutlookState();
  assert.deepEqual(graph.violations, [], "a request broke a documented Graph rule");
  assert.equal(o.status, "ready", `status ${o.status}: ${o.error}`);
  assert.equal(o.pending, false);
  const cals = graph.calendarsNamed(acctId, OUTLOOK_CALENDAR_NAME);
  assert.equal(cals.length, 1, "exactly one WATnow calendar");
  assert.equal(cals[0].id, o.calendarId);
  const evs = graph.eventsIn(acctId, o.calendarId);
  const byKey = new Map();
  for (const ev of evs) byKey.set(keyOf(ev), [...(byKey.get(keyOf(ev)) || []), ev]);
  for (const [k, list2] of byKey) assert.equal(list2.length, 1, `duplicate events for ${k}`);
  const courses = new Map(list.courses.map((c) => [c.id, c]));
  const expected = new Map();
  for (const item of list.items) {
    const course = courses.get(item.courseId);
    if (!course) continue;
    const key = outlookKey(school, item);
    const rec = o.events[key];
    if (Date.parse(item.dueAt) > now || (rec && !rec.removed)) expected.set(key, { item, course });
  }
  assert.deepEqual([...byKey.keys()].sort(), [...expected.keys(), ...extraKeys].sort(), "Outlook holds exactly the expected deadlines");
  for (const [key, { item, course }] of expected) {
    const ev = byKey.get(key)[0];
    const want = outlookEvent(item, course, key);
    assert.equal(ev.subject, want.subject, key);
    assert.equal(Date.parse(ev.start.dateTime + "Z"), Date.parse(want.start.dateTime + "Z"), `${key} start`);
    assert.equal(Date.parse(ev.end.dateTime + "Z"), Date.parse(want.end.dateTime + "Z"), `${key} end`);
    assert.equal(ev.showAs, "free");
    assert.equal(o.events[key].graphId, ev.id, `${key}: WATnow's id is the real event`);
    assert.equal(o.events[key].fingerprint, outlookFingerprint(want), `${key} fingerprint`);
  }
  return { o, evs, byKey };
}

const eventPosts = (from = 0) => graph.writes(from).filter((e) => e.method === "POST" && /\/calendars\/[^/]+\/events$/.test(e.url.split("?")[0]));

beforeEach(() => {
  local.clear();
  session.clear();
  alarms.clear();
  sessionRules.clear();
  auth.__testing.reset();
  auth.__testing.setClientId(CLIENT);
  launchAccount = "acct-a";
  graph = createStrictGraph({ clientId: CLIENT, originStripped: originRuleActive });
  graph.addAccount(ACCT_A);
  graph.addAccount(ACCT_B);
});

// ---------------------------------------------------------------------------
describe("a. first sync of 48 deadlines", () => {
  for (const duplicateCalendarName of ["409", "allow"]) {
    test(`batched over several runs, exactly 48 events, calendar list paged (duplicate names: ${duplicateCalendarName})`, async () => {
      graph.cfg.duplicateCalendarName = duplicateCalendarName;
      graph.cfg.calendarPageSize = 5;
      const a = graph.accounts.get("acct-a");
      for (let n = 0; n < 12; n++) a.calendars.set(`other-${n}`, { id: `other-${n}`, name: `Other ${n}` });
      const list = makeTerm();
      await setList(list);
      seedConnected();

      const perRun = [];
      for (let r = 0; r < 10; r++) {
        const before = graph.graphIndex;
        await runOutlookSync();
        perRun.push(eventPosts(before).length);
        if (!(await getOutlookState()).pending) break;
        assert.ok(alarms.get(OUTLOOK_ALARM)?.when > Date.now(), "a follow-up run is scheduled");
      }
      assert.deepEqual(perRun, [20, 20, 8], "20 changes per run (MAX_CHANGES)");
      const { evs } = await assertInSync("acct-a", list);
      assert.equal(evs.length, 48);
      assert.equal(alarms.has(OUTLOOK_ALARM), false, "alarm cleared when done");
      // The calendar list was followed across its @odata.nextLink pages.
      assert.ok(graph.graphLog().some((e) => e.url.includes("$skiptoken=")));
      // Every create carried a transactionId and the WATnow tag.
      for (const e of eventPosts()) {
        assert.match(e.body.transactionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(e.body.singleValueExtendedProperties[0].id, WATNOW_PROP);
      }
    });
  }

  test("the Origin-stripping DNR rule is installed before the first token request", async () => {
    await setList(makeTerm());
    seedConnected();
    await runOutlookSync();
    const firstToken = graph.log.findIndex((e) => e.kind === "token");
    const firstRule = graph.log.findIndex((e) => e.kind === "dnr" && e.addRules.length);
    assert.ok(firstToken > -1 && firstRule > -1 && firstRule < firstToken, "rule added before token request");
    assert.equal(graph.log[firstToken].originStripped, true);
    assert.deepEqual(graph.log[firstToken].form.grant_type, "refresh_token");
  });

  test("without the DNR rule Microsoft refuses the token request (the fake models the browser's Origin)", async () => {
    // Prove the fake really enforces it: no DNR API => Origin would be sent => AADSTS9002326.
    const dnr = chrome.declarativeNetRequest;
    delete chrome.declarativeNetRequest;
    try {
      await setList(makeTerm());
      seedConnected();
      await runOutlookSync();
      const s = await getOutlookState();
      // WATnow treats invalid_request as a configuration error: status "error" (Try again).
      assert.equal(s.status, "error");
      assert.match(graph.violations[0].description, /AADSTS9002326/);
      assert.equal(graph.writes().length, 0);
    } finally {
      chrome.declarativeNetRequest = dnr;
    }
  });

  test("an existing WATnow calendar on a later page is reused, not duplicated", async () => {
    graph.cfg.calendarPageSize = 4;
    const a = graph.accounts.get("acct-a");
    for (let n = 0; n < 9; n++) a.calendars.set(`other-${n}`, { id: `other-${n}`, name: `Other ${n}` });
    a.calendars.set("existing-watnow", { id: "existing-watnow", name: OUTLOOK_CALENDAR_NAME });
    const list = makeTerm();
    await setList(list);
    seedConnected();
    await drain();
    const { o } = await assertInSync("acct-a", list);
    assert.equal(o.calendarId, "existing-watnow");
    assert.equal(graph.writes().filter((e) => e.url.endsWith("/me/calendars")).length, 0, "no calendar POST");
  });
});

// ---------------------------------------------------------------------------
async function fullySynced(list = makeTerm()) {
  await setList(list);
  seedConnected();
  await drain();
  await assertInSync("acct-a", list);
  return list;
}

test("b. idempotency: 5 more requested syncs with no change make zero writes", async () => {
  const list = await fullySynced();
  const mark = graph.graphIndex;
  const tokensBefore = graph.log.filter((e) => e.kind === "token").length;
  for (let n = 0; n < 5; n++) {
    await requestOutlookSync();
    await runOutlookSync();
  }
  assert.equal(graph.writes(mark).length, 0, "no POST/PATCH/DELETE");
  assert.ok(graph.graphIndex > mark, "the runs did talk to Graph (calendar check)");
  assert.equal(graph.log.filter((e) => e.kind === "token").length, tokensBefore, "cached access token reused");
  await assertInSync("acct-a", list);
});

test("c. moved date, check-off, removed deadline, dropped course", async () => {
  const list = await fullySynced();
  const moved = list.items.find((i) => i.id === "c1:dropbox:5");
  const checked = list.items.find((i) => i.id === "c2:dropbox:3");
  const removed = list.items.find((i) => i.id === "c2:dropbox:7");
  moved.dueAt = new Date(Date.parse(moved.dueAt) + 2 * DAY).toISOString();
  checked.status = "done";
  const c3Keys = list.items.filter((i) => i.courseId === "c3" && Date.parse(i.dueAt) > Date.now()).map((i) => outlookKey(SCHOOL, i));
  const next = { courses: list.courses.filter((c) => c.id !== "c3"), items: list.items.filter((i) => i !== removed && i.courseId !== "c3") };
  await setList(next);
  const mark = graph.graphIndex;
  await requestOutlookSync();
  await drain();
  const w = graph.writes(mark);
  assert.deepEqual(w.map((e) => e.method).sort(), ["DELETE", "PATCH", "PATCH"]);
  // c3's events stay (end of term / dropped course), and aren't counted as list items any more.
  const { o, byKey } = await assertInSync("acct-a", next, { extraKeys: c3Keys });
  assert.equal(byKey.get(outlookKey(SCHOOL, checked))[0].subject.startsWith("✓ "), true);
  assert.equal(o.events[outlookKey(SCHOOL, removed)].removed, true);
  assert.equal(byKey.has(outlookKey(SCHOOL, removed)), false);
  assert.equal(c3Keys.length, 16);
});

// ---------------------------------------------------------------------------
describe("d. crash between Outlook making the event and WATnow saving its id", () => {
  const isCreate = (e) => e.method === "POST" && /\/calendars\/[^/]+\/events$/.test(e.url);
  for (const [label, fault] of [
    ["connection drops after the POST is committed", { commitThenDrop: true }],
    ["response body is cut off after the POST is committed", { commitThenBadBody: true }],
  ]) {
    test(`${label}: next run finds the event by its tag, no duplicate`, async () => {
      const list = makeTerm();
      await setList(list);
      seedConnected();
      let seen = 0;
      graph.faultWhen((e) => isCreate(e) && ++seen === 7, fault);
      await runOutlookSync();
      const s1 = await getOutlookState();
      assert.equal(s1.status, "queued");
      const lost = graph.graphLog().find((e) => e.committed);
      const lostKey = keyOf(graph.accounts.get("acct-a").events.get(lost.created));
      assert.equal(s1.events[lostKey], undefined, "WATnow never saved this one");
      await drain();
      const { o } = await assertInSync("acct-a", list);
      assert.equal(o.events[lostKey].graphId, lost.created, "re-found the event Outlook already had");
      assert.ok(graph.graphLog().some((e) => e.method === "PATCH" && e.patched === lost.created));
    });
  }

  test("the tag search misses it too (search lag): the transactionId stops a second event", async () => {
    const list = makeTerm();
    await setList(list);
    seedConnected();
    let seen = 0;
    graph.faultWhen((e) => isCreate(e) && ++seen === 3, { commitThenDrop: true });
    await runOutlookSync();
    const lost = graph.graphLog().find((e) => e.committed);
    // The next lookup for that key (the first /me/events filter of the next run) comes back empty.
    graph.faultWhen((e) => e.method === "GET" && e.url.includes("/me/events?$filter="), { hideResults: true });
    await drain();
    await assertInSync("acct-a", list);
    assert.ok(graph.graphLog().some((e) => e.deduped === lost.created), "Graph deduplicated the retried POST");
  });
});

// ---------------------------------------------------------------------------
describe("e. throttling, outages and an expired token mid-run", () => {
  test("429 with Retry-After 30 at request 7: queued, alarm >= 30 s out, next runs finish", async () => {
    const list = makeTerm();
    await setList(list);
    seedConnected();
    graph.faults.set(7, { status: 429, retryAfter: 30 });
    const t0 = Date.now();
    await runOutlookSync();
    const s = await getOutlookState();
    assert.equal(s.status, "queued");
    assert.equal(s.pending, true);
    assert.equal(s.attempts, 1);
    const alarm = alarms.get(OUTLOOK_ALARM);
    assert.ok(alarm.when - t0 >= 30000, `alarm in ${alarm.when - t0} ms`);
    assert.equal(graph.graphLog().filter((e) => e.i > 7).length, 0, "nothing more sent after the 429");
    await drain();
    await assertInSync("acct-a", list);
  });

  test("503 and a network failure mid-run are retried to completion", async () => {
    const list = makeTerm();
    await setList(list);
    seedConnected();
    graph.faults.set(5, { status: 503 });
    graph.faults.set(30, { network: true });
    await drain();
    await assertInSync("acct-a", list);
  });

  test("401 once: access token dropped, refreshed with the saved refresh token, rotation saved, sync completes", async () => {
    const list = makeTerm();
    await setList(list);
    const rt1 = seedConnected();
    graph.faults.set(9, { expireToken: true });
    await runOutlookSync();
    let s = await getOutlookState();
    assert.equal(s.status, "queued");
    assert.equal(session.has("outlookToken"), false, "access token invalidated");
    const tokensBefore = graph.log.filter((e) => e.kind === "token").length;
    await drain();
    const tokens = graph.log.filter((e) => e.kind === "token");
    assert.equal(tokens.length, tokensBefore + 1, "exactly one refresh after the 401");
    const rt2 = tokens.at(-2).issued;
    assert.equal(tokens.at(-1).form.refresh_token, rt2, "used the newest (rotated) refresh token");
    assert.notEqual(rt2, rt1);
    assert.equal(local.get("outlookAuth").refreshToken, tokens.at(-1).issued, "newest refresh token stored");
    await assertInSync("acct-a", list);
  });

  test("401 on every request: gives up after 4 attempts and asks to reconnect, no writes", async () => {
    await setList(makeTerm());
    seedConnected();
    graph.faultWhen(() => true, { expireToken: true }, 1000);
    const runs = await drain();
    const s = await getOutlookState();
    assert.equal(s.status, "reconnect");
    assert.equal(s.attempts, 4);
    assert.equal(runs, 4);
    assert.equal(alarms.has(OUTLOOK_ALARM), false);
    assert.equal(graph.writes().length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("f. student deletes one event in Outlook", () => {
  for (const transactionIdScope of ["live", "ever"]) {
    test(`untouched: not recreated; once the deadline changes: recreated once (transactionId dedupe: ${transactionIdScope})`, async () => {
      graph.cfg.transactionIdScope = transactionIdScope;
      const list = await fullySynced();
      const item = list.items.find((i) => i.id === "c2:dropbox:4");
      const key = outlookKey(SCHOOL, item);
      const acct = graph.accounts.get("acct-a");
      const gone = [...acct.events.values()].find((e) => keyOf(e) === key);
      acct.events.delete(gone.id);

      // Documented behaviour: a rescan with no change to that deadline leaves it deleted.
      let mark = graph.graphIndex;
      await requestOutlookSync();
      await drain();
      assert.equal(graph.writes(mark).length, 0);
      assert.equal([...acct.events.values()].some((e) => keyOf(e) === key), false, "an untouched deleted event is NOT recreated");

      item.dueAt = new Date(Date.parse(item.dueAt) + DAY).toISOString();
      await setList(list);
      mark = graph.graphIndex;
      await requestOutlookSync();
      await drain();
      assert.deepEqual(graph.writes(mark).map((e) => `${e.method} ${e.status}`), ["PATCH 404", "POST 201"]);
      const { o } = await assertInSync("acct-a", list);
      assert.equal(o.events[key].version, 1);
    });
  }

  test("deadline removed after the student already deleted its event: DELETE 404 counts as done", async () => {
    const list = await fullySynced();
    const item = list.items.find((i) => i.id === "c2:dropbox:4");
    const key = outlookKey(SCHOOL, item);
    const acct = graph.accounts.get("acct-a");
    acct.events.delete([...acct.events.values()].find((e) => keyOf(e) === key).id);
    const next = { ...list, items: list.items.filter((i) => i !== item) };
    await setList(next);
    await requestOutlookSync();
    await drain();
    const { o } = await assertInSync("acct-a", next);
    assert.equal(o.events[key].removed, true);
  });
});

// ---------------------------------------------------------------------------
describe("g. student deletes the whole WATnow calendar", () => {
  async function deleteCalendarAndResync() {
    const list = await fullySynced();
    const acct = graph.accounts.get("acct-a");
    const old = (await getOutlookState()).calendarId;
    acct.calendars.delete(old);
    for (const [id, e] of acct.events) if (e.calendarId === old) acct.events.delete(id);
    await requestOutlookSync();
    await drain();
    return { list, old };
  }

  test("transactionId dedupe only for live events: calendar and all 48 events come back", async () => {
    graph.cfg.transactionIdScope = "live";
    const { list, old } = await deleteCalendarAndResync();
    const { o, evs } = await assertInSync("acct-a", list);
    assert.notEqual(o.calendarId, old);
    assert.equal(evs.length, 48);
  });

  // Whether Exchange still dedupes a transactionId whose event was deleted isn't documented.
  // Before 6689ff1 the recreated events reused `key:v0` and, in this mode, none came back;
  // since then the calendar id is part of the transactionId.
  test("transactionId remembered even after deletion (undocumented): calendar and all 48 events still come back", async () => {
    graph.cfg.transactionIdScope = "ever";
    const { list, old } = await deleteCalendarAndResync();
    const { o, evs } = await assertInSync("acct-a", list);
    assert.notEqual(o.calendarId, old);
    assert.equal(evs.length, 48);
    assert.equal(graph.graphLog().filter((e) => e.deduped).length, 0, "no create was swallowed as a retry");
  });
});

// ---------------------------------------------------------------------------
describe("h. disconnect mid-sync, then reconnect", () => {
  async function disconnectDuringRun(atIndex) {
    const list = makeTerm();
    await setList(list);
    seedConnected();
    graph.hooks.set(atIndex, () => stopOutlookSync({ disconnect: true }));
    await runOutlookSync();
    return list;
  }

  test("no Graph request starts after the disconnect; sign-in and rule removed", async () => {
    await disconnectDuringRun(15);
    assert.equal(graph.graphLog().filter((e) => e.i > 15).length, 0, "nothing after the disconnect");
    const s = await getOutlookState();
    assert.equal(s.enabled, false);
    assert.equal(s.account, null);
    assert.equal(s.status, "off");
    assert.equal(local.has("outlookAuth"), false);
    assert.equal(sessionRules.size, 0);
    assert.equal(alarms.has(OUTLOOK_ALARM), false);
    // And a stray alarm firing later does nothing.
    const mark = graph.graphIndex;
    await runOutlookSync();
    assert.equal(graph.graphIndex, mark);
  });

  test("reconnect to a DIFFERENT account: events go only to the new account", async () => {
    const list = await disconnectDuringRun(15);
    const aEventsBefore = graph.accounts.get("acct-a").events.size;
    const mark = graph.graphIndex;
    launchAccount = "acct-b";
    const r = await connectOutlookCalendar(ACCT_B.mail);
    assert.equal(r.ok, true, r.reason);
    await drain();
    assert.equal(graph.graphLog().filter((e) => e.i > mark && e.accountId === "acct-a").length, 0, "no request reached account A");
    assert.equal(graph.accounts.get("acct-a").events.size, aEventsBefore, "account A untouched");
    const { evs } = await assertInSync("acct-b", list);
    assert.equal(evs.length, 48);
  });

  test("reconnect to the SAME account: the half-synced calendar is reused, no duplicates", async () => {
    const list = await disconnectDuringRun(15);
    launchAccount = "acct-a";
    const r = await connectOutlookCalendar(ACCT_A.mail);
    assert.equal(r.ok, true, r.reason);
    await drain();
    const { evs } = await assertInSync("acct-a", list);
    assert.equal(evs.length, 48);
  });
});

// ---------------------------------------------------------------------------
test("i. school change mid-sync stops the run; the old school's events are never touched again", async () => {
  const list = makeTerm();
  await setList(list);
  seedConnected();
  graph.hooks.set(12, async () => {
    local.set("settings", { mode: "live", school: "uoguelph" });
  });
  await runOutlookSync();
  assert.equal(graph.graphLog().filter((e) => e.i > 12).length, 0, "no request after the school changed");
  const s = await getOutlookState();
  // A cancelled run returns without saving: the status it set at the start stays.
  assert.equal(s.status, "syncing");
  assert.equal(s.pending, true);
  assert.ok(alarms.has(OUTLOOK_ALARM), "a retry alarm is still set, so it is not stuck");
  const waterlooIds = new Set([...graph.accounts.get("acct-a").events.keys()]);
  assert.ok(waterlooIds.size > 0);

  // The new school's list arrives and syncs; the old events stay as they were.
  const guelph = { courses: [{ id: "g1", code: "CIS 1300", name: "Programming" }], items: [{ id: "g1:dropbox:1", courseId: "g1", kind: "dropbox", title: "Lab 1", dueAt: new Date(Date.now() + 2 * DAY).toISOString(), status: "open", url: "" }] };
  await setList(guelph, "uoguelph");
  const mark = graph.graphIndex;
  await requestOutlookSync();
  await drain();
  for (const e of graph.writes(mark)) {
    if (e.method !== "POST") assert.ok(!waterlooIds.has(e.patched || e.deleted), "touched an old-school event");
  }
  assert.deepEqual(graph.writes(mark).map((e) => e.method), ["POST"]);
  const o = await getOutlookState();
  assert.equal(o.status, "ready");
  assert.deepEqual(graph.violations, []);
  // NOTE: settings.mode can't be changed in this build: core/build.js TESTER_BUILD = true and
  // store.js mergeSettings() forces mode "live", so the mode half of the guard is unreachable here.
});

// ---------------------------------------------------------------------------
describe("j. service worker restart between runs", () => {
  test("module memory reset (session storage kept): continues with the session access token", async () => {
    const list = makeTerm();
    await setList(list);
    seedConnected();
    await runOutlookSync();
    const tokens = graph.log.filter((e) => e.kind === "token").length;
    auth.__testing.reset();
    auth.__testing.setClientId(CLIENT); // a constant in real builds
    await resumeOutlookSync();
    await drain();
    assert.equal(graph.log.filter((e) => e.kind === "token").length, tokens, "no new token needed");
    await assertInSync("acct-a", list);
  });

  test("browser restart (memory and session storage gone): refreshes with the stored, rotated refresh token", async () => {
    const list = makeTerm();
    await setList(list);
    seedConnected();
    for (let n = 0; n < 2; n++) {
      await runOutlookSync();
      auth.__testing.reset();
      auth.__testing.setClientId(CLIENT);
      session.clear();
      sessionRules.clear(); // session rules die with the browser too
      await resumeOutlookSync();
    }
    await drain();
    const tokens = graph.log.filter((e) => e.kind === "token");
    assert.equal(tokens.length, 3);
    for (let n = 1; n < tokens.length; n++) assert.equal(tokens[n].form.refresh_token, tokens[n - 1].issued, "each refresh used the previous rotation");
    assert.equal(local.get("outlookAuth").refreshToken, tokens.at(-1).issued);
    assert.ok(tokens.every((t) => t.originStripped), "DNR rule re-installed after the restart");
    await assertInSync("acct-a", list);
  });
});
