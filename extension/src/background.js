// Service worker: reads Learn (the DEMO catalog or real Learn in LIVE mode),
// keeps state, sets the toolbar badge, sends notifications and runs the demo
// shortcuts.

import { getState, setState, getSettings, setSettings, getCatalog, setCatalog, emptyState, DEFAULT_SETTINGS } from "./core/store.js";
import { buildCatalog, learnUrl } from "./data/demo-source.js";
import { createSource } from "./data/source.js";
import { liveBase, assignColors } from "./data/live-source.js";
import { currentSchool, schoolOrigins, schoolPatterns, homeUrl, systemName, DEFAULT_SCHOOL } from "./core/schools.js";
import { DEMO_SCRIPT } from "./data/fixtures.js";
import { addDays, endOfWeek, startOfDay } from "./core/dates.js";
import { plannedReminders, reminderCopy, movedCopy, unsubmittedCopy, canConfirm } from "./core/reminders.js";
import { pingInstall, pingDayActive } from "./core/usage.js";
import { probeCrowdmark } from "./data/crowdmark-probe.js";
import { crowdmarkAllowed, crowdmarkBase, crowdmarkSubmitted, readCrowdmark } from "./data/crowdmark-source.js";

const BADGE_BG = "#FFE45C";
const BADGE_TEXT = "#17181C";

/* ------------------------------------------------------------------ */
/* Serialized state writes                                             */
/* ------------------------------------------------------------------ */

let chain = Promise.resolve();
function mutate(fn) {
  const run = chain.then(async () => {
    const s = await getState();
    const next = (await fn(s)) || s;
    await setState(next);
    return next;
  });
  chain = run.catch(() => {});
  return run;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

async function setup() {
  await migrateSchool();
  await syncBridge().catch((e) => console.warn("bridge", e));
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn("sidePanel behavior", e);
  }
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await ensureCatalog();
  await refreshBadge();
  await scheduleReminders();
  chrome.alarms.create("tick", { periodInMinutes: 5 });
  await syncLiveAlarm();
}

/** Every origin the LIVE site loads from: the school's, its aliases, and the test mock when one stands in. */
function liveOrigins(settings) {
  return [...new Set([liveBase(settings), ...schoolOrigins(currentSchool(settings))])];
}

/**
 * Installs from before the school picker read Waterloo Learn. One that has read
 * Learn before keeps doing so without being asked to pick.
 */
async function migrateSchool() {
  const settings = await getSettings();
  if (settings.mode !== "live" || settings.school) return;
  const s = await getState();
  if (s.lastSyncAt) await setSettings({ school: DEFAULT_SCHOOL });
}

const BRIDGE_ID = "school-bridge";

/**
 * The manifest runs the bridge on Waterloo Learn only. Another school's pages
 * get it registered here, once the student has granted access to that site.
 */
async function syncBridge() {
  if (!chrome.scripting) return;
  const settings = await getSettings();
  const school = settings.mode === "live" ? currentSchool(settings) : null;
  const patterns = school && school.id !== DEFAULT_SCHOOL ? schoolPatterns(school) : [];
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] });
  } catch {
    /* not registered */
  }
  if (!patterns.length) return;
  const granted = await chrome.permissions.contains({ origins: patterns }).catch(() => false);
  if (!granted) return;
  await chrome.scripting.registerContentScripts([{ id: BRIDGE_ID, matches: patterns, js: ["src/content/learn-bridge.js"], runAt: "document_start", persistAcrossSessions: true }]);
}

chrome.permissions.onAdded.addListener(() => syncBridge());
chrome.permissions.onRemoved.addListener(() => syncBridge());

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") pingInstall();
  setup();
});
chrome.runtime.onStartup.addListener(() => setup().then(startupCheck));

/**
 * Once per browser session (chrome.storage.session is empty after Chrome
 * starts): if the last good read of Learn is more than 30 minutes old, check
 * again in 30 seconds instead of waiting for the next 30 minute alarm.
 */
async function startupCheck() {
  try {
    const { startupChecked } = await chrome.storage.session.get("startupChecked");
    if (startupChecked) return;
    await chrome.storage.session.set({ startupChecked: true });
  } catch {
    return;
  }
  const settings = await getSettings();
  if (settings.mode !== "live") return;
  const s = await getState();
  if (!s.lastSyncAt) return;
  if (Date.now() - Date.parse(s.lastSyncAt) < SYNC_EVERY_MS) return;
  chrome.alarms.create(LIVE_SYNC, { delayInMinutes: 0.5, periodInMinutes: 30 });
}

/** DEMO: the catalog is rebuilt when the day changes so dates stay relative to today. */
async function ensureCatalog() {
  const settings = await getSettings();
  let cat = await getCatalog();
  const today = startOfDay(new Date()).toISOString();
  if (!cat || cat.builtDay !== today || cat.learnBase !== settings.learnBase) {
    const stale = cat && cat.builtDay !== today;
    cat = buildCatalog(settings);
    await setCatalog(cat);
    if (stale && settings.mode !== "live") await setState(emptyState());
  }
  return cat;
}

/* ------------------------------------------------------------------ */
/* Reading Learn                                                       */
/* ------------------------------------------------------------------ */

let scanning = false;
let pendingScan = false;
// Bumped when the student switches between demo and live data, so a read that
// is still running for the old mode stops writing.
let modeEpoch = 0;

async function runScan() {
  if (scanning) {
    pendingScan = true;
    return;
  }
  scanning = true;
  pendingScan = false;
  const epoch = modeEpoch;
  try {
    const settings = await getSettings();
    // No school picked yet: the panel shows the school picker instead of reading.
    if (settings.mode === "live" && !currentSchool(settings)) return;
    // Access to the school's site was taken back in Chrome's settings: pick again,
    // which asks for it again, instead of reading and failing as if offline.
    const school = settings.mode === "live" ? currentSchool(settings) : null;
    if (school && school.id !== DEFAULT_SCHOOL && !settings.liveBaseOverride) {
      const granted = await chrome.permissions.contains({ origins: [`${school.origin}/*`] }).catch(() => true);
      if (!granted) {
        await setSettings({ school: null });
        return;
      }
    }
    if (settings.mode === "live") {
      await runLiveScan(settings, epoch);
      return;
    }
    const cat = await ensureCatalog();
    const source = createSource(settings, getCatalog);
    await mutate((s) => ({
      ...emptyState(),
      demo: s.demo || { moveStep: 0 },
      scan: { status: "running", courses: [], startedAt: nowIso(), finishedAt: null },
      seq: (s.seq || 0) + 1,
      lastEvent: { type: "scan-start", seq: (s.seq || 0) + 1, at: nowIso() },
    }));
    const courses = await source.listCourses();
    if (epoch !== modeEpoch) return;
    await mutate((s) => {
      s.courses = courses;
      s.student = cat.student;
      s.scan.courses = courses.map((c) => ({ courseId: c.id, status: "waiting", found: 0 }));
    });
    for (let i = 0; i < courses.length; i++) {
      if (epoch !== modeEpoch) return;
      await mutate((s) => {
        s.scan.courses[i].status = "reading";
      });
      const items = await source.listDeadlines(courses[i], i);
      if (epoch !== modeEpoch) return;
      await mutate((s) => {
        s.scan.courses[i] = { courseId: courses[i].id, status: "done", found: items.length };
        s.items.push(...items);
      });
    }
    await wait(240);
    if (epoch !== modeEpoch) return;
    await mutate((s) => {
      s.scan.status = "done";
      s.scan.finishedAt = nowIso();
      s.lastSyncAt = nowIso();
      s.seq += 1;
      s.lastEvent = { type: "scan-done", seq: s.seq, at: nowIso() };
    });
    await refreshBadge();
    await scheduleReminders();
  } catch (e) {
    console.error(e);
    if (epoch === modeEpoch) {
      await mutate((s) => {
        s.scan.status = "error";
        s.error = String(e && e.message ? e.message : e);
      });
    }
  } finally {
    scanning = false;
    if (pendingScan && epoch !== modeEpoch) runScan();
    pendingScan = false;
  }
}

async function runSync() {
  const s0 = await getState();
  if (s0.scan.status !== "done" || s0.syncing) return;
  await mutate((s) => {
    s.syncing = true;
  });
  await wait(1100);
  const cat = await getCatalog();
  await mutate((s) => {
    for (const item of s.items) {
      const fresh = cat && cat.items.find((c) => c.id === item.id);
      if (!fresh) continue;
      if (fresh.status === "submitted" && item.status !== "submitted") {
        item.status = "submitted";
        item.completedAt = fresh.completedAt;
      }
    }
    s.syncing = false;
    s.lastSyncAt = nowIso();
  });
  await refreshBadge();
}

/* ------------------------------------------------------------------ */
/* Reading real Learn (LIVE)                                           */
/* ------------------------------------------------------------------ */

const LIVE_SYNC = "live-sync";
const SYNC_EVERY_MS = 30 * 60 * 1000;
const MOVED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// Sources an item can come from. Older stored items have no seenIn, so all of them must read.
const ALL_SOURCES = ["dropbox", "quizzes", "discussions", "feed", "calendar"];
let liveSyncing = false;

async function syncLiveAlarm() {
  const settings = await getSettings();
  if (settings.mode !== "live") {
    await chrome.alarms.clear(LIVE_SYNC);
    return;
  }
  const existing = await chrome.alarms.get(LIVE_SYNC);
  if (!existing) chrome.alarms.create(LIVE_SYNC, { delayInMinutes: 30, periodInMinutes: 30 });
}

/** Runs one GET through an open Learn tab's content script (learn-bridge.js). */
async function relayFetch(base, path) {
  let tabs = [];
  const settings = await getSettings();
  const school = settings.mode === "live" ? currentSchool(settings) : null;
  const patterns = school && school.origin === base ? schoolPatterns(school) : [`${base}/*`];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch {
    return { noTab: true };
  }
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    if (tab.discarded) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "live:fetch", path });
      if (res) return res;
    } catch {
      // No bridge in this tab. Tabs opened before the extension loaded need a reload.
    }
  }
  return { noTab: true };
}

async function saveLiveReport(source, extra) {
  try {
    const report = source.finishReport({ version: chrome.runtime.getManifest().version, ...extra });
    // Link fallbacks come from clicks, not reads, so they carry over from the last report.
    const { liveDebug: last } = await chrome.storage.local.get("liveDebug");
    if (last && last.linkFallbacks) report.linkFallbacks = last.linkFallbacks;
    await chrome.storage.local.set({ liveDebug: report });
  } catch (e) {
    console.warn("live report", e);
  }
}

function abortError() {
  const err = new Error("mode changed");
  err.code = "aborted";
  return err;
}

/**
 * Reads every current course from Learn. A course that fails is left out of the
 * fresh items and listed in `failed`, so its stored items are kept. A unit with
 * no term that fails to read stays too when WATnow already had items from it.
 */
/**
 * Adds Crowdmark to a Learn read, when the student connected it. Crowdmark
 * items go under the Learn course with the same code, or under a course of
 * their own. "crowdmark" is added to readOk for every course Crowdmark read
 * completely, which is what lets mergeLive drop an item that is gone. When
 * Crowdmark is signed out or unreachable nothing is added, so stored Crowdmark
 * items and courses stay. When it is not connected, every course counts as
 * read, so stored Crowdmark items go away.
 */
/** The scan list row that stands for the Crowdmark read. Not a course id. */
const CROWDMARK_ROW = "crowdmark";

/** Keeps `since` at the moment the status last changed, so a signed-out spell can be measured. */
function crowdmarkState(prev, status) {
  const at = nowIso();
  const since = prev && prev.status === status && prev.since ? prev.since : at;
  const okAt = status === "ok" ? at : prev && prev.okAt;
  return { status, at, since, okAt };
}

async function addCrowdmark(settings, learnCourses, readOk, prevCourses, allowed) {
  const markOk = (id) => readOk.set(id, new Set([...(readOk.get(id) || []), "crowdmark"]));
  const before = (prevCourses || []).filter((c) => c.crowdmark);
  if (!allowed) {
    for (const c of learnCourses) markOk(c.id);
    return { status: "off", courses: [], items: [], report: null };
  }
  const cm = await readCrowdmark(settings, learnCourses);
  if (cm.status !== "ok") return { status: cm.status, courses: before, items: [], report: cm.report };
  const had = new Set(before.map((c) => c.id));
  const courses = cm.courses.filter((c) => !c.readFailed || had.has(c.id)).map(({ readFailed, ...c }) => c);
  for (const c of [...learnCourses, ...courses]) if (!cm.failedCourseIds.has(c.id)) markOk(c.id);
  return { status: "ok", courses, items: cm.items, report: cm.report };
}

async function readLive(source, epoch, { onCourses, onProgress, onCrowdmark, prevItems = [], prevCourses = [] } = {}) {
  const session = await source.checkSession();
  if (!session.signedIn) return { session };
  if (epoch !== modeEpoch) throw abortError();
  const all = await source.listCourses();
  // Current-term courses show in the scan list. Units with no term (co-op
  // community, certificates) are read after them, off screen, and kept only
  // if the source says they have something coming up.
  const courses = all.filter((c) => c.current !== false);
  const extras = all.filter((c) => c.current === false);
  if (onCourses) await onCourses(courses);
  // Crowdmark gets a row of its own under the courses. It is marked reading
  // as soon as the course rows finish, so the termless units read after them
  // and the Crowdmark read itself do not look like a stall.
  const cmOn = await crowdmarkAllowed(source.settings);
  if (cmOn && onCrowdmark) await onCrowdmark("waiting", 0);
  const items = [];
  const failed = new Set();
  for (let i = 0; i < courses.length; i++) {
    if (epoch !== modeEpoch) throw abortError();
    if (onProgress) await onProgress(i, "reading", 0);
    try {
      const found = await source.listDeadlines(courses[i], i);
      items.push(...found);
      if (onProgress) await onProgress(i, "done", found.length);
    } catch (e) {
      if (e.code === "signed-out") throw e;
      console.warn("course read failed", courses[i].code, e);
      failed.add(courses[i].id);
      if (onProgress) await onProgress(i, "error", 0);
    }
  }
  if (cmOn && onCrowdmark) await onCrowdmark("reading", 0);
  const keptExtras = [];
  const hadItems = new Set(prevItems.map((i) => i.courseId));
  for (const c of extras) {
    if (epoch !== modeEpoch) throw abortError();
    try {
      const found = source.keepTermless(c, await source.listDeadlines(c));
      if (!found) continue;
      keptExtras.push(c);
      items.push(...found);
    } catch (e) {
      if (e.code === "signed-out") throw e;
      console.warn("unit read failed", c.code, e);
      if (hadItems.has(c.id)) {
        keptExtras.push(c);
        failed.add(c.id);
      }
    }
  }
  if (epoch !== modeEpoch) throw abortError();
  const readOk = source.readOk || new Map();
  const crowdmark = await addCrowdmark(source.settings, [...courses, ...keptExtras], readOk, prevCourses, cmOn);
  if (epoch !== modeEpoch) throw abortError();
  if (cmOn && onCrowdmark) await onCrowdmark(crowdmark.status === "ok" ? "done" : "error", crowdmark.items.length);
  items.push(...crowdmark.items);
  const kept = assignColors([...courses, ...keptExtras, ...crowdmark.courses]);
  const ids = new Set(kept.map((c) => c.id));
  return {
    session,
    courses: kept,
    items: items.filter((i) => ids.has(i.courseId)),
    failed,
    readOk,
    crowdmark: { status: crowdmark.status, report: crowdmark.report },
    allFailed: courses.length > 0 && courses.every((c) => failed.has(c.id)),
  };
}

/**
 * Compares a fresh read with what was stored. Keeps check-offs and marks
 * changed due dates as moved. A date that changed only because Learn now gives
 * it from a different field (DueDate removed, so the end date is used) is
 * updated without counting as a move. An item that is no longer on Learn, or
 * no longer has a date, is dropped, unless one of the places it was read from
 * failed this time.
 */
function mergeLive(prevItems, fresh, { failed, readOk, courseIds }, now = new Date()) {
  const prev = new Map((prevItems || []).map((i) => [i.id, i]));
  const at = now.toISOString();
  const moved = [];
  const items = fresh.map((f) => {
    const p = prev.get(f.id);
    if (!p) return f;
    const item = { ...f };
    if (p.status === "done" && f.status === "open") {
      item.status = "done";
      item.completedAt = p.completedAt;
      if (p.handIn) {
        item.handIn = p.handIn;
        item.handInAt = p.handInAt;
      }
    }
    if (Date.parse(p.dueAt) !== Date.parse(f.dueAt)) {
      const fieldChanged = p.dueField && f.dueField && p.dueField !== f.dueField;
      if (!fieldChanged) {
        item.moved = { from: p.dueAt, at };
        moved.push({ item, from: p.dueAt });
      }
    } else if (p.moved && now - Date.parse(p.moved.at) < MOVED_KEEP_MS) {
      item.moved = p.moved;
    }
    return item;
  });
  const freshIds = new Set(fresh.map((f) => f.id));
  for (const p of prevItems || []) {
    if (freshIds.has(p.id) || !courseIds.has(p.courseId)) continue;
    const ok = readOk.get(p.courseId);
    const from = p.seenIn && p.seenIn.length ? p.seenIn : ALL_SOURCES;
    const gone = !failed.has(p.courseId) && ok && from.every((x) => ok.has(x));
    if (gone) continue;
    const { missing, ...keep } = p;
    items.push(keep);
  }
  return { items, moved };
}

/** "Moved" notifications, only for work that is still open. */
async function notifyMoved(moved, st) {
  for (const { item, from } of moved) {
    if (item.status !== "open") continue;
    const course = st.courses.find((c) => c.id === item.courseId);
    if (course) await notify("moved", item.id, movedCopy(item, course, from), st.seq);
  }
}

function errorText(e) {
  return String(e && e.message ? e.message : e);
}

/** Why a read failed, in the terms the panel uses. */
function failureKind(e) {
  return e && e.code === "signed-out" ? "signed-out" : "unreachable";
}

/**
 * The very first good read (or the first after Delete my data) only schedules
 * reminders from now on. Reminder times that already passed are marked as
 * handled so they don't all go out at once.
 */
function skipPastReminders(s, settings) {
  const cutoff = Date.now();
  for (const p of plannedReminders(s.items, settings, new Date(0))) {
    if (p.fireAt.getTime() <= cutoff && !s.sent[p.key]) s.sent[p.key] = nowIso();
  }
}

/** What a full read keeps from before, in case it fails. */
function carryOf(s) {
  if (s.carry && !Array.isArray(s.carry)) return s.carry;
  return {
    items: Array.isArray(s.carry) ? s.carry : s.items || [],
    courses: s.courses || [],
    student: s.student || null,
    lastSyncAt: s.lastSyncAt || null,
  };
}

/**
 * A full read failed. With a saved list from an earlier read, the list stays
 * and the panel shows a notice, unless the login really expired. With no list
 * yet, the panel shows a sign in or "couldn't reach" screen.
 */
function restoreAfterFailure(s, carry, kind, error) {
  s.items = carry.items || [];
  s.courses = carry.courses || [];
  s.student = carry.student || null;
  s.lastSyncAt = carry.lastSyncAt || null;
  delete s.carry;
  s.error = error || null;
  s.scan.finishedAt = nowIso();
  if (carry.lastSyncAt && kind !== "signed-out") {
    s.scan.status = "done";
    s.scan.courses = [];
    s.errorKind = null;
    s.stale = { kind, at: nowIso(), online: navigator.onLine };
    return;
  }
  s.scan.status = "error";
  s.errorKind = kind === "unreachable" ? "offline" : "signed-out";
  s.stale = null;
}

async function runLiveScan(settings, epoch) {
  const source = createSource(settings, getCatalog, { relay: relayFetch });
  const before = await getState();
  const carry = carryOf(before);
  const firstRead = !carry.lastSyncAt && !carry.items.length;
  await mutate((s) => ({
    ...emptyState(),
    sent: s.sent || {},
    carry,
    scan: { status: "running", courses: [], startedAt: nowIso(), finishedAt: null },
    seq: (s.seq || 0) + 1,
    lastEvent: { type: "scan-start", seq: (s.seq || 0) + 1, at: nowIso() },
  }));
  const extra = { run: "scan" };
  try {
    const result = await readLive(source, epoch, {
      prevItems: carry.items,
      prevCourses: carry.courses,
      onCourses: (courses) =>
        mutate((s) => {
          if (epoch !== modeEpoch) return;
          s.courses = courses;
          s.scan.courses = courses.map((c) => ({ courseId: c.id, status: "waiting", found: 0 }));
        }),
      onProgress: (i, status, found) =>
        mutate((s) => {
          if (epoch !== modeEpoch || !s.scan.courses[i]) return;
          s.scan.courses[i] = { ...s.scan.courses[i], status, found };
        }),
      onCrowdmark: (status, found) =>
        mutate((s) => {
          if (epoch !== modeEpoch) return;
          const row = { courseId: CROWDMARK_ROW, status, found };
          const i = s.scan.courses.findIndex((p) => p.courseId === CROWDMARK_ROW);
          if (i < 0) s.scan.courses.push(row);
          else s.scan.courses[i] = row;
        }),
    });
    if (epoch !== modeEpoch) return;
    if (!result.session.signedIn) {
      extra.outcome = result.session.reason;
      await mutate((s) => restoreAfterFailure(s, carry, result.session.reason));
      return;
    }
    if (result.allFailed) {
      extra.outcome = "every-course-failed";
      await mutate((s) => restoreAfterFailure(s, carry, "unreachable", "Every course failed to read"));
      return;
    }
    const ids = new Set(result.courses.map((c) => c.id));
    const { items, moved } = mergeLive(carry.items, result.items, { failed: result.failed, readOk: result.readOk, courseIds: ids });
    extra.outcome = "ok";
    extra.counts = { courses: result.courses.length, items: items.length, failedCourses: result.failed.size, moved: moved.length };
    extra.crowdmark = result.crowdmark;
    await wait(240);
    if (epoch !== modeEpoch) return;
    const latest = await getSettings();
    const next = await mutate((s) => {
      s.courses = result.courses;
      s.student = result.session.student || null;
      s.scan.courses = s.scan.courses.filter((p) => ids.has(p.courseId) || p.courseId === CROWDMARK_ROW);
      s.items = items;
      s.crowdmark = crowdmarkState(s.crowdmark, result.crowdmark.status);
      delete s.carry;
      if (firstRead) skipPastReminders(s, latest);
      s.stale = null;
      s.error = null;
      s.errorKind = null;
      s.scan.status = "done";
      s.scan.finishedAt = nowIso();
      s.lastSyncAt = nowIso();
      s.seq += 1;
      s.lastEvent = { type: "scan-done", seq: s.seq, at: nowIso() };
    });
    await notifyMoved(moved, next);
  } catch (e) {
    if (e.code === "aborted" || epoch !== modeEpoch) return;
    console.error(e);
    extra.outcome = e.code || "error";
    extra.error = errorText(e);
    await mutate((s) => restoreAfterFailure(s, carry, failureKind(e), errorText(e)));
  } finally {
    if (epoch === modeEpoch) {
      await saveLiveReport(source, extra);
      await refreshBadge();
      await scheduleReminders();
    }
  }
}

/**
 * A check that could not reach Learn. The list and every reminder stay, and
 * the next 30 minute alarm tries again. Only when the student is looking at
 * the panel and an open Learn tab confirms the login expired does the panel
 * switch to the sign in screen.
 */
function markStale(s, kind, error, fromPanel) {
  s.syncing = false;
  s.error = error || null;
  s.stale = { kind, at: nowIso(), online: navigator.onLine };
  if (kind === "signed-out" && fromPanel) {
    s.scan.status = "error";
    s.errorKind = "signed-out";
  }
}

let cmReading = false;

/**
 * Reads Crowdmark alone, without re-reading Learn, so connecting and signing
 * in show up in seconds. Learn items are kept as they are: only the
 * "crowdmark" source is marked read, so mergeLive drops nothing else.
 */
async function readCrowdmarkOnly() {
  const settings = await getSettings();
  const s0 = await getState();
  if (cmReading || settings.mode !== "live" || s0.scan.status !== "done") return (s0.crowdmark && s0.crowdmark.status) || "off";
  if (!(await crowdmarkAllowed(settings))) return "off";
  cmReading = true;
  try {
    const readOk = new Map();
    const cm = await addCrowdmark(settings, s0.courses.filter((c) => !c.crowdmark), readOk, s0.courses, true);
    await mutate((s) => {
      s.crowdmark = crowdmarkState(s.crowdmark, cm.status);
      if (cm.status !== "ok") return;
      const courses = assignColors([...s.courses.filter((c) => !c.crowdmark), ...cm.courses]);
      s.items = mergeLive(s.items, cm.items, { failed: new Set(), readOk, courseIds: new Set(courses.map((c) => c.id)) }).items;
      s.courses = courses;
    });
    return cm.status;
  } finally {
    cmReading = false;
  }
}

// Signing in to Crowdmark ends on a Crowdmark page that isn't a sign-in page.
// When that loads and Crowdmark isn't reading yet, read it right away instead
// of waiting for the next 30 minute check.
chrome.tabs.onUpdated.addListener(async (_id, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  const settings = await getSettings();
  const base = crowdmarkBase(settings);
  if (!tab.url.startsWith(base) || /\/(sign-in|sign_in|login|saml|auth)/i.test(new URL(tab.url).pathname)) return;
  const st = await getState();
  if (st.crowdmark && st.crowdmark.status === "ok") return;
  readCrowdmarkOnly();
});

/** The 30 minute check, the refresh button, and retries after Learn was unreachable. */
async function runLiveSync({ fromPanel = false } = {}) {
  if (scanning || liveSyncing) return;
  const s0 = await getState();
  const hasList = s0.scan.status === "done" || (s0.scan.status === "error" && s0.lastSyncAt);
  if (!hasList) return;
  liveSyncing = true;
  const epoch = modeEpoch;
  const settings = await getSettings();
  const source = createSource(settings, getCatalog, { relay: relayFetch });
  const extra = { run: "sync", fromPanel };
  await mutate((s) => {
    s.syncing = true;
  });
  try {
    const result = await readLive(source, epoch, { prevItems: s0.items, prevCourses: s0.courses });
    if (epoch !== modeEpoch) return;
    if (!result.session.signedIn) {
      extra.outcome = result.session.reason;
      await mutate((s) => markStale(s, result.session.reason, null, fromPanel));
      return;
    }
    if (result.allFailed) {
      extra.outcome = "every-course-failed";
      await mutate((s) => markStale(s, "unreachable", "Every course failed to read", fromPanel));
      return;
    }
    const ids = new Set(result.courses.map((c) => c.id));
    let moved = [];
    const next = await mutate((s) => {
      const merged = mergeLive(s.items, result.items, { failed: result.failed, readOk: result.readOk, courseIds: ids });
      moved = merged.moved;
      s.courses = result.courses;
      s.student = result.session.student || s.student || null;
      s.items = merged.items;
      s.crowdmark = crowdmarkState(s.crowdmark, result.crowdmark.status);
      s.syncing = false;
      s.error = null;
      s.errorKind = null;
      s.stale = null;
      s.scan.status = "done";
      s.lastSyncAt = nowIso();
      if (moved.length) {
        s.seq += 1;
        s.lastEvent = { type: "moved", itemId: moved[moved.length - 1].item.id, seq: s.seq, at: nowIso() };
      }
    });
    extra.outcome = "ok";
    extra.counts = { courses: result.courses.length, items: next.items.length, failedCourses: result.failed.size, moved: moved.length };
    extra.crowdmark = result.crowdmark;
    await notifyMoved(moved, next);
  } catch (e) {
    if (e.code === "aborted" || epoch !== modeEpoch) return;
    console.error(e);
    extra.outcome = e.code || "error";
    extra.error = errorText(e);
    await mutate((s) => markStale(s, failureKind(e), errorText(e), fromPanel));
  } finally {
    liveSyncing = false;
    if (epoch === modeEpoch) {
      await saveLiveReport(source, extra);
      await refreshBadge();
      await scheduleReminders();
    } else {
      await mutate((s) => {
        s.syncing = false;
      });
    }
  }
}

/**
 * Retries a check that failed because Learn was unreachable. `wentOffline`
 * limits it to failures that happened while Chrome reported no network, so the
 * 5 minute tick only asks Learn again once the network is back.
 */
async function retryUnreachable({ wentOffline }) {
  if (!navigator.onLine) return;
  const settings = await getSettings();
  if (settings.mode !== "live") return;
  const s = await getState();
  if (s.scan.status === "error" && s.errorKind === "offline") {
    if (!scanning) runScan();
    return;
  }
  if (!s.stale || s.stale.kind !== "unreachable") return;
  if (wentOffline && s.stale.online !== false) return;
  await runLiveSync();
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

async function refreshBadge() {
  const s = await getState();
  if (s.scan.status !== "done") {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const now = new Date();
  const eow = endOfWeek(now);
  const n = s.items.filter((i) => i.status === "open" && new Date(i.dueAt) >= now && new Date(i.dueAt) <= eow).length;
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setTitle({ title: n ? `${n} due on Learn by Sunday` : chrome.i18n.getMessage("actionTitle") });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

async function notify(kind, itemId, copy, seq) {
  const id = `wn|${kind}|${itemId}|${seq || Date.now()}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: copy.title,
    message: copy.message,
    priority: 2,
  });
  return id;
}

chrome.notifications.onClicked.addListener(async (id) => {
  const [, , itemId] = id.split("|");
  chrome.notifications.clear(id);
  // Acting on a reminder is using WATnow, even if the panel never opens.
  pingDayActive("reminder");
  if (itemId) await openItem(itemId);
});

// How long a click waits on the link check before opening the first link anyway.
const LINK_CHECK_MS = 1500;
const ERROR_PAGE = /\/d2l\/(?:error|common\/errorpages?)\b/i;
// Only a title that starts with the error, so an item called "Error Analysis Lab" still opens.
const ERROR_TITLE = /<title>\s*(?:not authori[sz]ed|not found|page not available|error)\b/i;

/**
 * Asks the school's site whether a link opens a real page before sending the
 * student there. Item links are built from Brightspace's usual page paths, and
 * a school running a different version or tool can answer those with an error
 * page. "bad" is a clear error, "ok" a page, "unknown" anything that can't be
 * judged (signed out, offline, slow), which opens the link as it is.
 */
async function checkLink(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(LINK_CHECK_MS) });
  } catch {
    return { verdict: "unknown", status: 0 };
  }
  const status = res.status;
  const final = String(res.url || url);
  // Sent to a login: the school's sign-in decides where they land after.
  if (/\/d2l\/login/i.test(final) || new URL(final).origin !== new URL(url).origin) return { verdict: "unknown", status };
  if (status === 403 || status === 404 || status === 410 || status >= 500 || ERROR_PAGE.test(new URL(final).pathname)) return { verdict: "bad", status };
  if (!res.ok) return { verdict: "unknown", status };
  if ((res.headers.get("content-type") || "").includes("html")) {
    try {
      const head = (await res.text()).slice(0, 8000);
      if (ERROR_TITLE.test(head)) return { verdict: "bad", status };
    } catch {
      /* body cut off: judge by status alone */
    }
  }
  return { verdict: "ok", status };
}

/**
 * The first link that opens: the item, then its course's list for that kind of
 * item, then the course home, then the site home. The last one is never checked.
 * Every fallback taken is kept for the debug report, as a path with the ids
 * swapped out, so reports show which of a school's page paths don't work.
 */
async function firstWorkingLink(candidates, kind) {
  const links = [...new Set(candidates.filter(Boolean))];
  const misses = [];
  let chosen = links[links.length - 1];
  for (let i = 0; i < links.length - 1; i++) {
    const { verdict, status } = await checkLink(links[i]);
    if (verdict !== "bad") {
      chosen = links[i];
      break;
    }
    misses.push({ kind, path: new URL(links[i]).pathname.replace(/\d+/g, "{n}"), status });
  }
  if (misses.length) {
    const { liveDebug } = await chrome.storage.local.get("liveDebug");
    if (liveDebug) {
      liveDebug.linkFallbacks = [...(liveDebug.linkFallbacks || []), ...misses].slice(-10);
      await chrome.storage.local.set({ liveDebug });
    }
  }
  return chosen;
}

async function openItem(itemId) {
  const s = await getState();
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return;
  const settings = await getSettings();
  // Learn answers "Not Authorized" for an item that has not opened yet, so send
  // those to the course's list page, where it shows with the date it unlocks.
  const locked = item.opensAt && Date.parse(item.opensAt) > Date.now();
  let url = (locked && item.listUrl) || item.url;
  if (settings.mode === "live") {
    const course = s.courses.find((c) => c.id === item.courseId);
    const school = currentSchool(settings);
    url = await firstWorkingLink([url, item.listUrl, course && course.homeUrl, school && homeUrl(school)], item.kind);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // A Crowdmark item reuses the tab only when it is already on Crowdmark, so a Learn tab is never taken over.
  const home = item.kind === "crowdmark" ? [crowdmarkBase(settings)] : (settings.mode === "live" ? liveOrigins(settings) : [settings.learnBase]);
  const isLearn = tab && tab.url && home.some((h) => h && tab.url.startsWith(h));
  if (tab && isLearn) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url });
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

async function scheduleReminders() {
  const settings = await getSettings();
  await chrome.alarms.clear("reminder");
  if (settings.mode === "demo" && !settings.reminders.demoAutoSend) return;
  const s = await getState();
  // A saved list keeps its reminders even while Learn can't be read.
  const hasList = s.scan.status === "done" || (s.scan.status === "error" && s.lastSyncAt);
  if (!hasList) return;
  const plan = plannedReminders(s.items, settings).filter((p) => !s.sent[p.key]);
  if (plan.length) chrome.alarms.create("reminder", { when: Math.max(Date.now() + 1000, plan[0].fireAt.getTime()) });
}

/**
 * Asks Learn whether a dropbox folder or quiz was handed in since the last
 * read. Resolves to null when Learn can't be asked in time.
 */
async function submissionCheck(settings, item) {
  let timer;
  try {
    const source = createSource(settings, getCatalog, { relay: relayFetch });
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 15000);
    });
    return await Promise.race([source.submissionState(item), late]);
  } catch (e) {
    console.warn("submission check", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Asks Learn or Crowdmark, whichever the item lives on. */
function askSubmitted(settings, item) {
  return item.kind === "crowdmark" ? crowdmarkSubmitted(settings, item) : submissionCheck(settings, item);
}

function siteName(settings, item) {
  return item.kind === "crowdmark" ? "Crowdmark" : systemName(settings);
}

let reminderRun = Promise.resolve();
function sendDueReminders() {
  reminderRun = reminderRun.then(sendDueRemindersNow).catch((e) => console.error(e));
  return reminderRun;
}

async function sendDueRemindersNow() {
  const settings = await getSettings();
  const now = new Date();
  let due = [];
  // Claim the reminders first, so a second alarm can't send them again while
  // Learn is being asked.
  const s = await mutate((st) => {
    // Include reminders whose time already passed (Chrome was closed), one per item.
    const plan = plannedReminders(st.items, settings, new Date(0)).filter(
      (p) => !st.sent[p.key] && p.fireAt <= new Date(now.getTime() + 30000)
    );
    const latestPerItem = new Map();
    for (const p of plan) latestPerItem.set(p.itemId, p);
    due = [...latestPerItem.values()];
    for (const p of plan) st.sent[p.key] = nowIso();
  });
  const handedIn = [];
  const missing = [];
  for (const p of due) {
    const item = s.items.find((i) => i.id === p.itemId);
    const course = item && s.courses.find((c) => c.id === item.courseId);
    if (!item || !course || new Date(item.dueAt) <= new Date()) continue;
    // The reminder says "you haven't submitted", so ask Learn first. If Learn
    // can't be asked, the reminder still goes out.
    if (settings.mode === "live" && canConfirm(item)) {
      const check = await askSubmitted(settings, item);
      if (check && check.submitted) {
        handedIn.push({ id: item.id, at: check.at });
        continue;
      }
      // A checked-off item only gets a reminder when the site says for sure
      // that nothing is handed in.
      if (item.status === "done") {
        if (!check) continue;
        missing.push(item.id);
        await notify("reminder", item.id, unsubmittedCopy(item, course, siteName(settings, item), new Date()));
        continue;
      }
    }
    await notify("reminder", item.id, reminderCopy(item, course, new Date()));
  }
  if (handedIn.length || missing.length) {
    await mutate((st) => {
      for (const id of missing) {
        const item = st.items.find((i) => i.id === id);
        if (item && item.status === "done") {
          item.handIn = "missing";
          item.handInAt = nowIso();
        }
      }
      for (const h of handedIn) {
        const item = st.items.find((i) => i.id === h.id);
        if (!item || item.status === "submitted") continue;
        item.status = "submitted";
        item.completedAt = h.at || nowIso();
        delete item.handIn;
        delete item.handInAt;
        st.seq += 1;
        st.lastEvent = { type: "submitted", itemId: item.id, seq: st.seq, at: nowIso() };
      }
    });
    await refreshBadge();
  }
  await scheduleReminders();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "reminder") await sendDueReminders();
  if (alarm.name === LIVE_SYNC) {
    const settings = await getSettings();
    if (settings.mode === "live") await runLiveSync();
  }
  if (alarm.name === "tick") {
    await ensureCatalog();
    await refreshBadge();
    await retryUnreachable({ wentOffline: true });
  }
});

// Chrome says the network is back. Only fires while the worker is awake; the
// 5 minute tick covers the rest.
self.addEventListener("online", () => {
  retryUnreachable({ wentOffline: false });
});

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function demoMove() {
  const s = await getState();
  if (s.scan.status !== "done") return { ok: false, reason: "Open the side panel first so it can read your courses." };
  const step = s.demo?.moveStep || 0;
  const move = DEMO_SCRIPT.moves[step];
  if (!move) return { ok: false, reason: "Both scripted date changes are used. Reset the demo to run them again." };

  // 1. The prof changes the date on Learn.
  const cat = await getCatalog();
  const learnItem = cat.items.find((i) => i.id === move.itemId);
  if (!learnItem) return { ok: false, reason: `No item called ${move.itemId} in fixtures.js.` };
  const from = learnItem.dueAt;
  const to = addDays(new Date(from), move.shiftDays).toISOString();
  learnItem.dueAt = to;
  learnItem.moved = { from, at: nowIso() };
  await setCatalog(cat);

  // 2. WATnow picks up the change.
  const next = await mutate((st) => {
    const item = st.items.find((i) => i.id === move.itemId);
    if (!item) return;
    item.moved = { from: item.dueAt, at: nowIso() };
    item.dueAt = to;
    st.demo = { ...(st.demo || {}), moveStep: step + 1 };
    st.seq += 1;
    st.lastEvent = { type: "moved", itemId: item.id, seq: st.seq, at: nowIso() };
    st.lastSyncAt = nowIso();
  });
  const item = next.items.find((i) => i.id === move.itemId);
  const course = next.courses.find((c) => c.id === item.courseId);
  await notify("moved", item.id, movedCopy(item, course, from), next.seq);
  await refreshBadge();
  await scheduleReminders();
  return { ok: true };
}

async function demoReminder() {
  const s = await getState();
  if (s.scan.status !== "done") return { ok: false, reason: "Open the side panel first so it can read your courses." };
  const settings = await getSettings();
  const now = new Date();
  const muted = new Set(settings.reminders.mutedCourses);
  const eligible = (i) => i.status === "open" && new Date(i.dueAt) > now && !muted.has(i.courseId);
  let item = s.items.find((i) => i.id === DEMO_SCRIPT.reminder.itemId && eligible(i));
  if (!item) item = [...s.items].filter(eligible).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0];
  if (!item) return { ok: false, reason: "Nothing open to remind about. Reset the demo." };
  const course = s.courses.find((c) => c.id === item.courseId);
  const next = await mutate((st) => {
    st.seq += 1;
    st.lastEvent = { type: "reminded", itemId: item.id, seq: st.seq, at: nowIso() };
  });
  await notify("reminder", item.id, reminderCopy(item, course, now), next.seq);
  return { ok: true };
}

async function clearNotifications() {
  const all = await chrome.notifications.getAll();
  await Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id)));
}

async function demoReset() {
  const settings = await getSettings();
  await setCatalog(buildCatalog(settings));
  await chrome.alarms.clear("reminder");
  await mutate(() => emptyState());
  await clearNotifications();
  await refreshBadge();
  return { ok: true };
}

async function deleteData() {
  modeEpoch++;
  await chrome.alarms.clear(LIVE_SYNC);
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await setCatalog(buildCatalog(DEFAULT_SETTINGS));
  await setState({ ...emptyState(), deletedAt: nowIso() });
  await clearNotifications();
  await chrome.alarms.clear("reminder");
  await refreshBadge();
  return { ok: true };
}

async function learnSubmitted({ orgUnitId, itemId }) {
  const cat = await getCatalog();
  const course = cat && cat.courses.find((c) => String(c.orgUnitId) === String(orgUnitId));
  const learnItem = cat && cat.items.find((i) => i.id === itemId && (!course || i.courseId === course.id));
  if (!learnItem) return { ok: false };
  learnItem.status = "submitted";
  learnItem.completedAt = nowIso();
  await setCatalog(cat);
  await mutate((st) => {
    const item = st.items.find((i) => i.id === itemId);
    if (!item || item.status === "submitted") return;
    item.status = "submitted";
    item.completedAt = learnItem.completedAt;
    st.seq += 1;
    st.lastEvent = { type: "submitted", itemId, seq: st.seq, at: nowIso() };
    st.lastSyncAt = nowIso();
  });
  await refreshBadge();
  await scheduleReminders();
  return { ok: true };
}

async function toggleDone(itemId) {
  const settings = await getSettings();
  let ask = null;
  await mutate((st) => {
    const item = st.items.find((i) => i.id === itemId);
    if (!item || item.status === "submitted") return;
    item.status = item.status === "done" ? "open" : "done";
    item.completedAt = item.status === "done" ? nowIso() : null;
    delete item.handIn;
    delete item.handInAt;
    // People check things off right after clicking submit, and sometimes the
    // file never went in. Ask the site while they're still looking.
    if (item.status === "done" && settings.mode === "live" && canConfirm(item)) {
      item.handIn = "checking";
      item.handInAt = nowIso();
      ask = { ...item };
    }
    st.seq += 1;
    st.lastEvent = { type: item.status === "done" ? "marked" : "unmarked", itemId, seq: st.seq, at: nowIso() };
  });
  await refreshBadge();
  await scheduleReminders();
  if (ask) confirmHandIn(settings, ask);
  return { ok: true };
}

/**
 * Right after a check-off, asks Learn or Crowdmark whether anything is handed
 * in. A yes turns the row into Submitted. A no leaves it checked off with a
 * warning. No answer drops the "checking" line and shows nothing.
 */
async function confirmHandIn(settings, item) {
  const check = await askSubmitted(settings, item).catch(() => null);
  await mutate((st) => {
    const it = st.items.find((i) => i.id === item.id);
    if (!it || it.status !== "done" || it.handIn !== "checking") return;
    if (check && check.submitted) {
      it.status = "submitted";
      it.completedAt = check.at || nowIso();
      delete it.handIn;
      delete it.handInAt;
      st.seq += 1;
      st.lastEvent = { type: "submitted", itemId: it.id, seq: st.seq, at: nowIso() };
    } else if (check) {
      it.handIn = "missing";
      it.handInAt = nowIso();
    } else {
      delete it.handIn;
      delete it.handInAt;
    }
  });
  await refreshBadge();
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

const lastRun = {};
function debounced(name, fn) {
  const t = Date.now();
  if (lastRun[name] && t - lastRun[name] < 700) return Promise.resolve({ ok: false, reason: "debounced" });
  lastRun[name] = t;
  return fn();
}

async function demoOnly(fn) {
  const settings = await getSettings();
  if (settings.mode === "live") return { ok: false, reason: "Demo controls only work while WATnow shows demo data." };
  return fn();
}

const DEMO_ACTIONS = {
  "demo-move-date": () => debounced("move", () => demoOnly(demoMove)),
  "demo-reminder": () => debounced("reminder", () => demoOnly(demoReminder)),
  "demo-reset": () => debounced("reset", () => demoOnly(demoReset)),
};

// The store build drops the manifest "commands", and chrome.commands is undefined
// without them. Touching it anyway would stop the rest of this worker from loading.
chrome.commands?.onCommand.addListener((command) => {
  const fn = DEMO_ACTIONS[command];
  if (fn) fn();
});

async function handle(msg, sender) {
  switch (msg && msg.type) {
    case "panel:opened": {
      await ensureCatalog();
      const s = await getState();
      if (s.scan.status === "idle" || s.scan.status === "error") runScan();
      else if (s.scan.status === "running" && !scanning) runScan();
      return { ok: true };
    }
    case "school:open": {
      // The panel just saved a school. Register the bridge for its site before the
      // tab opens, so the first page that loads there can wake a stuck panel.
      const settings = await getSettings();
      const school = currentSchool(settings);
      if (!school) return { ok: false };
      await syncBridge().catch((e) => console.warn("bridge", e));
      await chrome.tabs.create({ url: homeUrl(school) });
      return { ok: true };
    }
    case "panel:rescan":
      runScan();
      return { ok: true };
    case "panel:refresh":
      if ((await getSettings()).mode === "live") runLiveSync({ fromPanel: true });
      else runSync();
      return { ok: true };
    case "panel:check": {
      // The panel opened (or went back online) while the saved list is out of date.
      const settings = await getSettings();
      if (settings.mode !== "live") return { ok: true };
      const s = await getState();
      if (s.scan.status === "done" && s.stale) runLiveSync({ fromPanel: true });
      else if (s.scan.status === "error" && s.errorKind === "offline" && !scanning) runScan();
      return { ok: true };
    }
    case "item:open":
      await openItem(msg.itemId);
      return { ok: true };
    case "item:toggle-done":
      return toggleDone(msg.itemId);
    case "demo:move":
      return DEMO_ACTIONS["demo-move-date"]();
    case "demo:reminder":
      return DEMO_ACTIONS["demo-reminder"]();
    case "demo:reset":
      return DEMO_ACTIONS["demo-reset"]();
    case "data:delete":
      return deleteData();
    case "learn:submitted":
      return learnSubmitted(msg);
    case "live:learn-page": {
      // A Learn page loaded. If the panel is showing the signed-out state, try again.
      const settings = await getSettings();
      const origins = liveOrigins(settings);
      const from = String((sender && sender.url) || "");
      if (settings.mode !== "live" || msg.login || !origins.some((o) => from.startsWith(`${o}/`))) return { ok: true };
      const s = await getState();
      if (s.scan.status === "error" && !scanning) runScan();
      else if (s.scan.status === "done" && s.stale && Date.now() - Date.parse(s.stale.at) > 20000) runLiveSync();
      return { ok: true };
    }
    case "crowdmark:connect":
      return { ok: true, status: await readCrowdmarkOnly() };
    case "crowdmark:probe":
      return { ok: true, report: await probeCrowdmark("worker") };
    case "settings:changed":
      await scheduleReminders();
      return { ok: true };
    default:
      return { ok: false, reason: "unknown message" };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg, _sender).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
  return true;
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    const before = changes.settings.oldValue;
    const after = changes.settings.newValue;
    // A new school (or a new mode) starts over: the saved list belongs to the old site.
    if (after && before && (before.mode !== after.mode || (before.school || null) !== (after.school || null))) {
      modeEpoch++;
      await chrome.alarms.clear("reminder");
      await mutate(() => emptyState());
      await syncLiveAlarm();
      await refreshBadge();
      await syncBridge().catch((e) => console.warn("bridge", e));
    }
    if (after && before && before.learnBase !== after.learnBase) {
      const cat = await getCatalog();
      if (cat) {
        for (const i of cat.items) i.url = learnUrl(after.learnBase, cat.courses.find((c) => c.id === i.courseId), i);
        cat.learnBase = after.learnBase;
        await setCatalog(cat);
        await mutate((st) => {
          for (const i of st.items) {
            const c = cat.items.find((x) => x.id === i.id);
            if (c) i.url = c.url;
          }
        });
      }
    }
    await scheduleReminders();
  }
});

// Service workers can restart at any time; make sure badge colors stick.
setup().then(startupCheck);
