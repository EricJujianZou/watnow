import { getCalendarState, updateCalendarState, getSettings, getState } from "../core/store.js";
import { connectGoogle, getGoogleToken, disconnectGoogle, calendarError } from "./google-auth.js";
import { calendarApi } from "./google-api.js";
import { calendarPlan } from "./event-model.js";
import { GOOGLE_WEB_CLIENT_ID } from "./config.js";

export const CALENDAR_ALARM = "google-calendar-sync";
let running = null;

/** An insert may have reached Google even if its response never reached us.
 * Look up the deterministic ID before inserting, and recover a 409 as well. */
export async function reconcileEvent(api, calendarId, change) {
  let existing;
  try {
    existing = await api.getEvent(calendarId, change.id);
  } catch (e) {
    if (e.status === 410) return { deleted: true };
    if (e.status !== 404) throw e;
  }
  if (existing?.status === "cancelled") return { deleted: true };
  if (!existing) {
    try {
      await api.insertEvent(calendarId, { id: change.id, ...change.event });
      return { fingerprint: change.fingerprint };
    } catch (e) {
      if (e.status !== 409) throw e;
      existing = await api.getEvent(calendarId, change.id);
      if (existing?.status === "cancelled") return { deleted: true };
    }
  }
  if (existing.extendedProperties?.private?.watnowKey !== change.event.extendedProperties.private.watnowKey) {
    throw calendarError("ownership", "An event couldn't be identified as a WATnow deadline. Sync is paused.");
  }
  await api.patchEvent(calendarId, change.id, change.event);
  return { fingerprint: change.fingerprint };
}

/** Deletes an event whose item disappeared from state. Checked out the same
 * way as an update: only a WATnow-tagged event is removed. Already-gone is
 * treated as success, not an error to retry. */
export async function removeEvent(api, calendarId, id) {
  let existing;
  try {
    existing = await api.getEvent(calendarId, id);
  } catch (e) {
    if (e.status === 404 || e.status === 410) return;
    throw e;
  }
  if (existing.status === "cancelled") return;
  if (existing.extendedProperties?.private?.watnow !== "1") {
    throw calendarError("ownership", "An event couldn't be identified as a WATnow deadline. Sync is paused.");
  }
  await api.deleteEvent(calendarId, id);
}

export async function scheduleCalendarRetry(minutes = 1) {
  await chrome.alarms.create(CALENDAR_ALARM, { when: Date.now() + minutes * 60000 });
}

export async function requestCalendarSync() {
  const c = await updateCalendarState((s) => {
    if (!s.enabled) return false;
    s.pending = true;
    s.revision++;
  });
  if (!c.enabled || ["connecting", "reconnect", "error"].includes(c.status)) return;
  await scheduleCalendarRetry();
  runCalendarSync();
}

/** Safe on worker wake: recover any interrupted connection attempts. */
export async function resumeCalendarSync() {
  const c = await getCalendarState();
  if (c.status !== "connecting") return;
  await updateCalendarState((s) => {
    s.generation = crypto.randomUUID();
    s.enabled = false;
    s.status = "off";
    s.error = "Connection was interrupted. Select Connect Google Calendar to try again.";
  });
}

export async function recoverCalendarSync() {
  const c = await getCalendarState();
  if (c.enabled && !["connecting", "reconnect", "error"].includes(c.status)) await requestCalendarSync();
}

/** Explicit account connection. */
export async function connectCalendar({ changeAccount = false } = {}) {
  if (changeAccount && !GOOGLE_WEB_CLIENT_ID) {
    return { ok: false, reason: "Account switching needs a Web OAuth client configured for this build." };
  }
  const before = await getCalendarState();
  if (before.status === "connecting") return { ok: false, reason: "Google account selection is already open." };
  const start = await updateCalendarState((s) => {
    s.generation = crypto.randomUUID();
    s.enabled = false;
    s.status = "connecting";
    s.error = null;
    s.pending = false;
  });
  await chrome.alarms.clear(CALENDAR_ALARM);
  try {
    const { account } = await connectGoogle();
    const c = await updateCalendarState((s) => {
      if (s.generation !== start.generation) return false;
      s.account = account;
      s.accounts[account.id] ||= { calendarId: null, events: {} };
      if (s.accounts[account.id].missing) s.accounts[account.id] = { calendarId: null, events: {} };
      s.enabled = true;
      s.dismissed = true;
      s.status = "ready";
      s.lastSyncAt = null;
      s.attempts = 0;
      s.error = null;
    });
    if (c.generation !== start.generation) return { ok: false, reason: "Connection cancelled." };
    await requestCalendarSync();
    return { ok: true };
  } catch (e) {
    await updateCalendarState((s) => {
      if (s.generation !== start.generation) return false;
      s.status = "off";
      s.error = e.code === "cancelled" ? null : (e.message || "Google Calendar couldn't connect. Try again later.");
    });
    return { ok: false, reason: e.message };
  }
}

export async function stopCalendarSync({ disconnect = false } = {}) {
  await updateCalendarState((s) => {
    s.generation = crypto.randomUUID();
    s.pending = false;
    s.status = s.enabled && !disconnect ? "ready" : "off";
    s.error = null;
    if (disconnect) {
      s.enabled = false;
      s.dismissed = true;
      s.account = null;
      s.lastSyncAt = null;
      s.accounts = {};
    }
  });
  await chrome.alarms.clear(CALENDAR_ALARM);
  if (disconnect) await disconnectGoogle();
}

export function runCalendarSync() {
  if (running) return running;
  running = runCalendarSyncNow().catch(() => console.warn("Calendar sync interrupted; pending work will resume.")).finally(() => { running = null; });
  return running;
}

async function runCalendarSyncNow() {
  const c = await getCalendarState();
  if (!c.enabled || !c.account || !c.pending || ["connecting", "reconnect", "error"].includes(c.status)) return;
  const settings = await getSettings();
  const state = await getState();
  if (settings.mode !== "live" || !settings.school || state.scan.status !== "done" || state.syncing) {
    await scheduleCalendarRetry();
    return;
  }
  const generation = c.generation;
  const accountId = c.account.id;
  const guard = async () => {
    const latest = await getCalendarState();
    const config = await getSettings();
    if (!latest.enabled || latest.generation !== generation || latest.revision !== c.revision || config.school !== settings.school || config.mode !== "live") {
      throw calendarError("cancelled", "Calendar sync changed.");
    }
  };
  const save = (fn) => updateCalendarState((s) => {
    if (!s.enabled || s.generation !== generation) return false;
    fn(s, s.accounts[accountId]);
  });
  try {
    await save((s) => { s.status = "syncing"; s.error = null; });
    await scheduleCalendarRetry();
    const token = await getGoogleToken(c.account);
    await guard();
    const api = calendarApi(token, guard);
    const record = c.accounts[accountId];

    let calendarId = record.calendarId;
    if (calendarId) {
      try {
        await api.getCalendar(calendarId);
      } catch (e) {
        if (e.status === 404 || e.status === 410 || e.status === 403) {
          calendarId = null;
          record.calendarId = null;
          record.events = {};
          await save((_s, r) => {
            r.calendarId = null;
            r.events = {};
          });
        } else {
          throw e;
        }
      }
    }
    if (!calendarId) {
      const created = await api.createCalendar();
      if (!created?.id) throw calendarError("setup", "Google Calendar couldn't be created. Try again later.");
      calendarId = created.id;
      record.calendarId = calendarId;
      record.events = {};
      await guard();
      await save((_s, r) => {
        r.calendarId = calendarId;
        r.events = {};
      });
    }

    const plan = await calendarPlan(state, settings.school, record.events);
    const started = Date.now();
    let done = 0;
    for (const change of plan) {
      if (done >= 20 || Date.now() - started > 25000) break;
      await guard();
      if (change.remove) {
        await removeEvent(api, calendarId, change.id);
        await guard();
        // Record removal without setting deleted: true, so republishing allows recreation
        await save((_s, r) => {
          r.events[change.id] = {
            id: change.id,
            key: change.key,
            version: (change.version || 0) + 1,
            removed: true,
            courseId: change.courseId,
            school: settings.school,
          };
        });
      } else {
        const result = await reconcileEvent(api, calendarId, change);
        await guard();
        await save((_s, r) => {
          if (result.deleted) {
            r.events[change.id] = {
              id: change.id,
              key: change.key,
              version: change.version,
              deleted: true,
              courseId: change.courseId,
              school: settings.school,
            };
          } else {
            r.events[change.id] = {
              id: change.id,
              key: change.key,
              version: change.version,
              fingerprint: change.fingerprint,
              removed: false,
              deleted: false,
              courseId: change.courseId,
              school: settings.school,
            };
          }
        });
      }
      done++;
    }
    await guard();
    const next = await save((s) => {
      s.pending = done < plan.length || s.revision !== c.revision;
      s.status = s.pending ? "queued" : "ready";
      s.attempts = 0;
      if (!s.pending) s.lastSyncAt = new Date().toISOString();
    });
    if (next.pending) await scheduleCalendarRetry(0.5);
    else {
      await chrome.alarms.clear(CALENDAR_ALARM);
      const latest = await getCalendarState();
      if (latest.enabled && latest.pending) await scheduleCalendarRetry(0.5);
    }
  } catch (e) {
    if (e.code === "cancelled") {
      const latest = await getCalendarState();
      if (latest.enabled && latest.pending) await scheduleCalendarRetry(0.5);
      return;
    }
    const next = await save((s) => {
      s.attempts++;
      const retry = e.retry && !(e.code === "token" && s.attempts >= 4);
      s.status = retry ? "queued" : ["auth", "token"].includes(e.code) ? "reconnect" : "error";
      s.error = e.message || "Calendar sync couldn't finish. Try again.";
      s.pending = true;
    });
    if (next.generation !== generation) return;
    if (next.status === "queued") await scheduleCalendarRetry(Math.min(60, 2 ** Math.min(next.attempts, 6)));
    else await chrome.alarms.clear(CALENDAR_ALARM);
  }
}
