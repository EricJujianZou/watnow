/*
  Keeps a "WATnow" calendar in the student's Outlook up to date.

  The student types the email they use for Outlook, signs in to Microsoft once
  (the email is filled in for them), and from then on every change WATnow sees
  on the school's site, and every deadline they add themselves, is sent to that
  calendar: new deadlines are created, moved dates and check-offs update the
  event, and a deadline that's gone is removed.

  State lives under its own storage key ("outlook"), separate from the list,
  so a rescan of the school's site never loses which Outlook event is which.
  No tokens are kept here: outlook-auth.js owns those.

    enabled, email, account { id, email, name }
    calendarId       the WATnow calendar in that account
    events           key -> { graphId, fingerprint, courseId, removed, version,
                              failed: the fingerprint Outlook last refused, if any }
    status           off | connecting | ready | syncing | queued | reconnect | error
    pending, revision, attempts, lastSyncAt, error, generation

  Graph picks its own event ids, so each event is also tagged with WATnow's key
  (an extended property) and created with a transactionId made from it. A sync
  interrupted after Outlook made an event but before WATnow saved its id finds
  that event again instead of making a second one.

  Like the Google sync, only upcoming open deadlines get a new event; one that
  already has an event keeps getting updates (a check-off adds a tick). A
  deadline that leaves the list is deleted from Outlook only while its course
  is still listed, so the end of a term doesn't wipe past events.
*/

import { getSettings, getState } from "../core/store.js";
import { calendarError } from "./google-auth.js";
import { connectOutlook, getOutlookToken, disconnectOutlook, invalidateOutlookToken, outlookAuthConfigured } from "./outlook-auth.js";
import { outlookApi } from "./outlook-api.js";
import { outlookEvent, outlookFingerprint, transactionIdFor } from "./outlook-model.js";
import { OUTLOOK_CALENDAR_NAME } from "./outlook-config.js";

export const OUTLOOK_ALARM = "outlook-calendar-sync";
const KEY = "outlook";
// At most this much per run, so one run never holds the worker for long.
const MAX_CHANGES = 20;
const MAX_RUN_MS = 25000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MICROSOFT_LOGIN = ["https://login.microsoftonline.com/*"];

/** An error about one item only: Outlook refused that request, and others can still go through. */
function itemOnly(e) {
  return e && e.code === "api" && !e.retry && e.status !== 401;
}

export function emptyOutlookState() {
  return {
    enabled: false,
    email: "",
    account: null,
    calendarId: null,
    events: {},
    status: "off",
    error: null,
    pending: false,
    revision: 0,
    attempts: 0,
    lastSyncAt: null,
    generation: 0,
  };
}

export async function getOutlookState() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  return { ...emptyOutlookState(), ...saved };
}

let chain = Promise.resolve();
/** Serialized writes. fn returns false to write nothing. */
export function updateOutlookState(fn) {
  const run = chain.then(async () => {
    const s = await getOutlookState();
    if ((await fn(s)) === false) return s;
    await chrome.storage.local.set({ [KEY]: s });
    return s;
  });
  chain = run.catch(() => {});
  return run;
}

/** WATnow's key for a deadline in Outlook: stable across reads, per school. */
export function outlookKey(school, item) {
  return `${school}:${item.id}`;
}

/**
 * What Outlook needs doing to match the list. Pure, so it can be tested.
 * @returns {Array<{ key, action: "create"|"update"|"delete", event?, fingerprint?, graphId?, courseId }>}
 */
export function outlookPlan(state, school, records = {}, now = Date.now()) {
  const courses = new Map((state.courses || []).map((c) => [c.id, c]));
  const plan = [];
  const live = new Set();
  for (const item of state.items || []) {
    const course = courses.get(item.courseId);
    const due = Date.parse(item.dueAt);
    if (!course || !Number.isFinite(due)) continue;
    const key = outlookKey(school, item);
    live.add(key);
    const rec = records[key];
    const event = outlookEvent(item, course, key);
    const fingerprint = outlookFingerprint(event);
    // Outlook refused this exact version: don't send it again until it changes.
    if (rec && rec.failed && rec.failed === fingerprint) continue;
    if (!rec || rec.removed) {
      if (item.status === "open" && due > now) plan.push({ key, action: "create", event, fingerprint, courseId: course.id });
    } else if (rec.fingerprint !== fingerprint) {
      plan.push({ key, action: "update", event, fingerprint, graphId: rec.graphId, courseId: course.id });
    }
  }
  for (const [key, rec] of Object.entries(records)) {
    if (live.has(key) || rec.removed || rec.failed === "delete" || !key.startsWith(`${school}:`)) continue;
    // End of term or a dropped course: leave past events in the calendar.
    if (rec.courseId && !courses.has(rec.courseId)) continue;
    plan.push({ key, action: "delete", graphId: rec.graphId, courseId: rec.courseId });
  }
  return plan;
}

export async function scheduleOutlookRetry(minutes = 1) {
  await chrome.alarms.create(OUTLOOK_ALARM, { when: Date.now() + minutes * 60000 });
}

/**
 * Something on the list changed: mark a sync as owed and start one. `manual`
 * is the student pressing Try again after a sync failed, which clears the
 * failure; an automatic request leaves a failed sync stopped until then.
 */
export async function requestOutlookSync({ manual = false } = {}) {
  const s = await updateOutlookState((x) => {
    if (!x.enabled) return false;
    x.pending = true;
    x.revision++;
    if (manual && x.status === "error") {
      x.status = "ready";
      x.error = null;
      x.attempts = 0;
    }
  });
  if (!s.enabled || ["connecting", "reconnect", "error"].includes(s.status)) return;
  await scheduleOutlookRetry();
  runOutlookSync();
}

/** On worker start: a sign-in that was open when the worker stopped can't finish. */
export async function resumeOutlookSync() {
  const s = await getOutlookState();
  if (s.status === "connecting") {
    await updateOutlookState((x) => {
      x.generation++;
      x.status = x.account ? "reconnect" : "off";
      x.enabled = !!x.account;
      x.error = "Connecting to Outlook was interrupted. Select Connect Outlook to try again.";
    });
  } else if (s.enabled && !["reconnect", "error"].includes(s.status)) {
    await requestOutlookSync();
  }
}

/**
 * Signs in to the Microsoft account for `email` and starts syncing.
 * Resolves to { ok } or { ok: false, reason } for the settings page.
 */
export async function connectOutlookCalendar(email) {
  if (!outlookAuthConfigured()) return { ok: false, reason: "Outlook sync isn't set up in this version of WATnow." };
  const typed = String(email || "").trim();
  if (!EMAIL.test(typed)) return { ok: false, reason: "Type the email you use for Outlook." };
  let already = false;
  const start = await updateOutlookState((s) => {
    // Checked and set in one write, so two clicks close together can't both start.
    if (s.status === "connecting") {
      already = true;
      return false;
    }
    s.generation++;
    s.status = "connecting";
    s.email = typed;
    s.error = null;
  });
  if (already) return { ok: false, reason: "A Microsoft sign-in is already open. Finish or close it first." };
  try {
    const { account } = await connectOutlook({ email: typed });
    const done = await updateOutlookState((s) => {
      if (s.generation !== start.generation) return false;
      // A different account than last time: its calendar and events are new.
      if (!s.account || s.account.id !== account.id) {
        s.calendarId = null;
        s.events = {};
      }
      s.account = account;
      s.enabled = true;
      s.status = "ready";
      s.attempts = 0;
      s.error = null;
      s.pending = true;
      s.revision++;
    });
    if (done.generation !== start.generation) return { ok: false, reason: "Connecting was cancelled." };
    // Signed in, but to a different address than the one typed: say so.
    const note = account.email && account.email.toLowerCase() !== typed.toLowerCase() ? `Signed in as ${account.email}.` : null;
    await scheduleOutlookRetry();
    runOutlookSync();
    return { ok: true, note };
  } catch (e) {
    await updateOutlookState((s) => {
      if (s.generation !== start.generation) return false;
      s.status = s.account && s.enabled ? "reconnect" : "off";
      s.error = e.code === "cancelled" ? null : e.message || "Outlook couldn't connect. Try again later.";
    });
    return { ok: false, reason: e.code === "cancelled" ? null : e.message };
  }
}

/** Stops syncing. disconnect also forgets the account; events already in Outlook stay. */
export async function stopOutlookSync({ disconnect = false } = {}) {
  await updateOutlookState((s) => {
    s.generation++;
    s.pending = false;
    s.error = null;
    if (disconnect) Object.assign(s, emptyOutlookState(), { generation: s.generation, email: s.email });
    else s.status = s.enabled ? "ready" : "off";
  });
  await chrome.alarms.clear(OUTLOOK_ALARM);
  if (disconnect) await disconnectOutlook().catch(() => {});
}

let running = null;
export function runOutlookSync() {
  if (running) return running;
  running = runNow()
    .catch((e) => console.warn("Outlook sync interrupted; pending work will resume.", e))
    .finally(() => {
      running = null;
    });
  return running;
}

async function runNow() {
  const s0 = await getOutlookState();
  if (!s0.enabled || !s0.account || !s0.pending || ["connecting", "reconnect", "error"].includes(s0.status)) return;
  const settings = await getSettings();
  const state = await getState();
  if (settings.mode !== "live" || !settings.school || state.scan.status !== "done" || state.syncing) {
    await scheduleOutlookRetry();
    return;
  }
  const { generation, revision } = s0;
  // Every request first checks nothing changed underneath it (a disconnect, a
  // new school, a newer list), and stops quietly if it did.
  const guard = async () => {
    const latest = await getOutlookState();
    const config = await getSettings();
    if (!latest.enabled || latest.generation !== generation || config.school !== settings.school || config.mode !== "live") {
      throw calendarError("cancelled", "Outlook sync changed.");
    }
  };
  const save = (fn) => updateOutlookState((s) => (s.enabled && s.generation === generation ? fn(s) : false));
  try {
    await save((s) => {
      s.status = "syncing";
      s.error = null;
    });
    await scheduleOutlookRetry();
    // Access to Microsoft's sign-in page was taken back (site access changed in
    // the browser): no token can be fetched, so ask for it again with Sign in again.
    if (!(await Promise.resolve(chrome.permissions?.contains?.({ origins: MICROSOFT_LOGIN }) ?? true).catch(() => true))) {
      throw calendarError("auth", "WATnow needs access to Microsoft's sign-in page. Select Sign in again and choose Allow.");
    }
    const token = await getOutlookToken(s0.account);
    await guard();
    const api = outlookApi(token, guard);
    const calendarId = await ensureCalendar(api, s0.calendarId, save);
    const records = calendarId === s0.calendarId ? { ...s0.events } : {};
    const plan = outlookPlan(state, settings.school, records);
    const started = Date.now();
    let done = 0;
    for (const change of plan) {
      if (done >= MAX_CHANGES || Date.now() - started > MAX_RUN_MS) break;
      let result;
      try {
        result = await apply(api, calendarId, change, records[change.key]);
      } catch (e) {
        // Outlook refused this one item for good (a 400 or 403 on it). Set it
        // aside and carry on with the rest, instead of stopping every sync on it.
        // Anything that would fail for every item (sign-in, busy, network,
        // the calendar itself) still stops the run below.
        if (!itemOnly(e)) throw e;
        console.warn("Outlook refused one deadline; it's skipped until it changes.", e.status, e.graphCode || "");
        const prev = records[change.key] || {};
        result = { ...prev, courseId: change.courseId, failed: change.action === "delete" ? "delete" : change.fingerprint };
      }
      await guard();
      await save((s) => {
        s.events[change.key] = result;
      });
      done++;
    }
    const next = await save((s) => {
      s.pending = done < plan.length || s.revision !== revision;
      s.status = s.pending ? "queued" : "ready";
      s.attempts = 0;
      s.skipped = Object.values(s.events).filter((r) => r && r.failed).length;
      if (!s.pending) s.lastSyncAt = new Date().toISOString();
    });
    if (next.pending) await scheduleOutlookRetry(0.5);
    else await chrome.alarms.clear(OUTLOOK_ALARM);
  } catch (e) {
    if (e.code === "cancelled") return;
    // Outlook turned the access token down: refresh it on the next try.
    if (e.code === "token") await invalidateOutlookToken().catch(() => {});
    const next = await save((s) => {
      s.attempts++;
      const retry = e.retry && !(e.code === "token" && s.attempts >= 4);
      s.status = retry ? "queued" : ["auth", "token"].includes(e.code) ? "reconnect" : "error";
      s.error = e.message || "Outlook sync couldn't finish. Try again.";
      s.pending = true;
    });
    if (next.generation !== generation) return;
    // Outlook says how long to wait when it's busy; otherwise back off.
    const wait = e.retryAfter ? Math.max(1, Math.ceil(e.retryAfter / 60)) : Math.min(60, 2 ** Math.min(next.attempts, 6));
    if (next.status === "queued") await scheduleOutlookRetry(wait);
    else await chrome.alarms.clear(OUTLOOK_ALARM);
  }
}

/** The WATnow calendar's id: the saved one if it still exists, else one found by name, else a new one. */
async function ensureCalendar(api, savedId, save) {
  if (savedId) {
    try {
      await api.getCalendar(savedId);
      return savedId;
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
  const existing = (await api.listCalendars()).find((c) => c && c.name === OUTLOOK_CALENDAR_NAME);
  const id = existing ? existing.id : (await api.createCalendar(OUTLOOK_CALENDAR_NAME))?.id;
  if (!id) throw calendarError("setup", "The WATnow calendar couldn't be made in Outlook. Try again later.");
  await save((s) => {
    s.calendarId = id;
    s.events = {};
  });
  return id;
}

/**
 * One change. Resolves to the record to save for its key.
 * `prev` is the key's saved record; its version goes up whenever the event has
 * to be made again, so Outlook doesn't take the new one for a retry of the old
 * one (a transactionId it has already seen is ignored).
 */
async function apply(api, calendarId, change, prev = {}) {
  const rec = { courseId: change.courseId, version: prev.version || 0 };
  if (change.action === "delete") {
    if (change.graphId) await api.deleteEvent(change.graphId);
    return { ...rec, removed: true, version: rec.version + 1 };
  }
  if (change.action === "update" && change.graphId) {
    try {
      await api.patchEvent(change.graphId, change.event);
      return { ...rec, graphId: change.graphId, fingerprint: change.fingerprint };
    } catch (e) {
      // Deleted in Outlook by the student: make it again.
      if (e.status !== 404 && e.status !== 410) throw e;
      rec.version++;
    }
  }
  // Already made by a run that stopped before saving its id? Find it by tag.
  const found = await api.findEventByKey(calendarId, change.key);
  if (found && found.id) {
    await api.patchEvent(found.id, change.event);
    return { ...rec, graphId: found.id, fingerprint: change.fingerprint };
  }
  // The calendar's id is in it too: a new calendar (the old one deleted, or
  // another account) starts versions over, and must not repeat an id Outlook
  // has already seen.
  const made = await api.createEvent(calendarId, { ...change.event, transactionId: transactionIdFor(`${calendarId}:${change.key}:v${rec.version}`) });
  return { ...rec, graphId: made && made.id, fingerprint: change.fingerprint };
}
