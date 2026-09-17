// Service worker: reads Learn (the DEMO catalog or real Learn in LIVE mode),
// keeps state, sets the toolbar badge, sends notifications and runs the demo
// shortcuts.

import { getState, setState, getSettings, getCatalog, setCatalog, emptyState, DEFAULT_SETTINGS } from "./core/store.js";
import { buildCatalog, learnUrl } from "./data/demo-source.js";
import { createSource } from "./data/source.js";
import { liveBase, assignColors } from "./data/live-source.js";
import { DEMO_SCRIPT } from "./data/fixtures.js";
import { addDays, endOfWeek, startOfDay } from "./core/dates.js";
import { plannedReminders, reminderCopy, movedCopy } from "./core/reminders.js";

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

chrome.runtime.onInstalled.addListener(() => setup());
chrome.runtime.onStartup.addListener(() => setup());

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
const MOVED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
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
  try {
    tabs = await chrome.tabs.query({ url: `${base}/*` });
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
 * fresh items and listed in `failed`, so its stored items are kept.
 */
async function readLive(source, epoch, { onCourses, onProgress } = {}) {
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
  const keptExtras = [];
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
    }
  }
  const kept = assignColors([...courses, ...keptExtras]);
  const ids = new Set(kept.map((c) => c.id));
  return { session, courses: kept, items: items.filter((i) => ids.has(i.courseId)), failed };
}

/**
 * Compares a fresh read with what was stored. Keeps check-offs, marks changed
 * due dates as moved, and keeps an item that vanished for one more sync in case
 * Learn had a hiccup.
 */
function mergeLive(prevItems, fresh, failed, courseIds, now = new Date()) {
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
    }
    if (Date.parse(p.dueAt) !== Date.parse(f.dueAt)) {
      item.moved = { from: p.dueAt, at };
      moved.push({ item, from: p.dueAt });
    } else if (p.moved && now - Date.parse(p.moved.at) < MOVED_KEEP_MS) {
      item.moved = p.moved;
    }
    return item;
  });
  const freshIds = new Set(fresh.map((f) => f.id));
  for (const p of prevItems || []) {
    if (freshIds.has(p.id) || !courseIds.has(p.courseId)) continue;
    if (failed.has(p.courseId)) items.push(p);
    else if (!p.missing) items.push({ ...p, missing: true });
  }
  return { items, moved };
}

async function notifyMoved(moved, st) {
  for (const { item, from } of moved) {
    const course = st.courses.find((c) => c.id === item.courseId);
    if (course) await notify("moved", item.id, movedCopy(item, course, from), st.seq);
  }
}

function errorText(e) {
  return String(e && e.message ? e.message : e);
}

async function runLiveScan(settings, epoch) {
  const source = createSource(settings, getCatalog, { relay: relayFetch });
  const before = await getState();
  const carry = before.carry || before.items || [];
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
    });
    if (epoch !== modeEpoch) return;
    if (!result.session.signedIn) {
      extra.outcome = result.session.reason;
      await mutate((s) => {
        s.scan.status = "error";
        s.errorKind = "signed-out";
        s.items = carry;
        delete s.carry;
      });
      return;
    }
    const ids = new Set(result.courses.map((c) => c.id));
    const { items, moved } = mergeLive(carry, result.items, result.failed, ids);
    extra.outcome = "ok";
    extra.counts = { courses: result.courses.length, items: items.length, failedCourses: result.failed.size, moved: moved.length };
    await wait(240);
    if (epoch !== modeEpoch) return;
    const next = await mutate((s) => {
      s.courses = result.courses;
      s.student = result.session.student || null;
      s.scan.courses = s.scan.courses.filter((p) => ids.has(p.courseId));
      s.items = items;
      delete s.carry;
      s.scan.status = "done";
      s.scan.finishedAt = nowIso();
      s.lastSyncAt = nowIso();
      s.seq += 1;
      s.lastEvent = { type: "scan-done", seq: s.seq, at: nowIso() };
    });
    await notifyMoved(moved, next);
    await refreshBadge();
    await scheduleReminders();
  } catch (e) {
    if (e.code === "aborted" || epoch !== modeEpoch) return;
    console.error(e);
    extra.outcome = e.code || "error";
    extra.error = errorText(e);
    await mutate((s) => {
      s.scan.status = "error";
      s.errorKind = e.code === "signed-out" ? "signed-out" : "error";
      s.error = errorText(e);
      s.items = carry;
      delete s.carry;
    });
  } finally {
    if (epoch === modeEpoch) await saveLiveReport(source, extra);
  }
}

/** The 30 minute check, and the refresh button, in LIVE mode. */
async function runLiveSync() {
  if (scanning || liveSyncing) return;
  const s0 = await getState();
  if (s0.scan.status !== "done") return;
  liveSyncing = true;
  const epoch = modeEpoch;
  const settings = await getSettings();
  const source = createSource(settings, getCatalog, { relay: relayFetch });
  const extra = { run: "sync" };
  await mutate((s) => {
    s.syncing = true;
  });
  try {
    const result = await readLive(source, epoch);
    if (epoch !== modeEpoch) return;
    if (!result.session.signedIn) {
      extra.outcome = result.session.reason;
      await mutate((s) => {
        s.syncing = false;
        s.scan.status = "error";
        s.errorKind = "signed-out";
      });
      return;
    }
    const ids = new Set(result.courses.map((c) => c.id));
    let moved = [];
    const next = await mutate((s) => {
      const merged = mergeLive(s.items, result.items, result.failed, ids);
      moved = merged.moved;
      s.courses = result.courses;
      s.items = merged.items;
      s.syncing = false;
      s.error = null;
      s.errorKind = null;
      s.lastSyncAt = nowIso();
      if (moved.length) {
        s.seq += 1;
        s.lastEvent = { type: "moved", itemId: moved[moved.length - 1].item.id, seq: s.seq, at: nowIso() };
      }
    });
    extra.outcome = "ok";
    extra.counts = { courses: result.courses.length, items: next.items.length, failedCourses: result.failed.size, moved: moved.length };
    await notifyMoved(moved, next);
  } catch (e) {
    if (e.code === "aborted" || epoch !== modeEpoch) return;
    console.error(e);
    extra.outcome = e.code || "error";
    extra.error = errorText(e);
    await mutate((s) => {
      s.syncing = false;
      s.error = errorText(e);
      if (e.code === "signed-out") {
        s.scan.status = "error";
        s.errorKind = "signed-out";
      }
    });
  } finally {
    liveSyncing = false;
    if (epoch === modeEpoch) {
      await saveLiveReport(source, extra);
      await refreshBadge();
      await scheduleReminders();
    }
  }
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
  if (itemId) await openItem(itemId);
});

async function openItem(itemId) {
  const s = await getState();
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return;
  const settings = await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const isLearn = tab && tab.url && (tab.url.startsWith(settings.learnBase) || tab.url.startsWith("https://learn.uwaterloo.ca"));
  if (tab && isLearn) await chrome.tabs.update(tab.id, { url: item.url });
  else await chrome.tabs.create({ url: item.url });
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

async function scheduleReminders() {
  const settings = await getSettings();
  await chrome.alarms.clear("reminder");
  if (settings.mode === "demo" && !settings.reminders.demoAutoSend) return;
  const s = await getState();
  if (s.scan.status !== "done") return;
  const plan = plannedReminders(s.items, settings).filter((p) => !s.sent[p.key]);
  if (plan.length) chrome.alarms.create("reminder", { when: Math.max(Date.now() + 1000, plan[0].fireAt.getTime()) });
}

async function sendDueReminders() {
  const settings = await getSettings();
  const s = await getState();
  const now = new Date();
  // Include reminders whose time already passed (Chrome was closed), one per item.
  const plan = plannedReminders(s.items, settings, new Date(0)).filter(
    (p) => !s.sent[p.key] && p.fireAt <= new Date(now.getTime() + 30000)
  );
  const latestPerItem = new Map();
  for (const p of plan) latestPerItem.set(p.itemId, p);
  for (const p of latestPerItem.values()) {
    const item = s.items.find((i) => i.id === p.itemId);
    const course = s.courses.find((c) => c.id === item.courseId);
    if (new Date(item.dueAt) <= now) continue;
    await notify("reminder", item.id, reminderCopy(item, course, now));
  }
  await mutate((st) => {
    for (const p of plan) st.sent[p.key] = nowIso();
  });
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
  }
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
  await mutate((st) => {
    const item = st.items.find((i) => i.id === itemId);
    if (!item || item.status === "submitted") return;
    item.status = item.status === "done" ? "open" : "done";
    item.completedAt = item.status === "done" ? nowIso() : null;
    st.seq += 1;
    st.lastEvent = { type: item.status === "done" ? "marked" : "unmarked", itemId, seq: st.seq, at: nowIso() };
  });
  await refreshBadge();
  await scheduleReminders();
  return { ok: true };
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
    case "panel:rescan":
      runScan();
      return { ok: true };
    case "panel:refresh":
      if ((await getSettings()).mode === "live") runLiveSync();
      else runSync();
      return { ok: true };
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
      const base = liveBase(settings);
      if (settings.mode !== "live" || msg.login || !sender || !String(sender.url || "").startsWith(`${base}/`)) return { ok: true };
      const s = await getState();
      if (s.scan.status === "error" && s.errorKind === "signed-out" && !scanning) runScan();
      return { ok: true };
    }
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
    if (after && before && before.mode !== after.mode) {
      modeEpoch++;
      await chrome.alarms.clear("reminder");
      await mutate(() => emptyState());
      await syncLiveAlarm();
      await refreshBadge();
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
setup();
