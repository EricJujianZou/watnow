import { getCalendarState, updateCalendarState, getSettings, getState } from "../core/store.js";
import { connectGoogle, getGoogleToken, disconnectGoogle, calendarError, configurationError, calendarMessage } from "./google-auth.js";
import { calendarApi } from "./google-api.js";
import { calendarPlan } from "./event-model.js";
import { CALENDAR_MARKER, googleConfigured } from "./config.js";

export const CALENDAR_ALARM = "google-calendar-sync";
let running = null;

/** An insert may have reached Google even if its response never reached us.
 * Look up the deterministic ID before inserting, and recover a 409 as well. */
export async function reconcileEvent(api, calendarId, change) {
  const eventId = change.eventId || change.id;
  let existing;
  try {
    existing = await api.getEvent(calendarId, eventId);
  } catch (e) {
    if (e.status === 410) return { deleted: true };
    if (e.status !== 404) throw e;
  }
  if (existing?.status === "cancelled") return { deleted: true };
  if (!existing) {
    try {
      await api.insertEvent(calendarId, { id: eventId, ...change.event });
      return { fingerprint: change.fingerprint };
    } catch (e) {
      if (e.status !== 409) throw e;
      try {
        existing = await api.getEvent(calendarId, eventId);
      } catch (e) {
        if (e.status === 410) return { deleted: true };
        throw e;
      }
      if (existing.status === "cancelled") return { deleted: true };
    }
  }
  if (existing.extendedProperties?.private?.watnowKey !== change.event.extendedProperties.private.watnowKey) {
    throw calendarError("ownership", "An event couldn't be identified as a WATnow deadline. Sync is paused.");
  }
  await api.patchEvent(calendarId, eventId, change.event);
  return { fingerprint: change.fingerprint };
}

/** Deletes an event whose item disappeared from state. Checked out the same
 * way as an update: only a WATnow-tagged event is removed. Already-gone is
 * treated as success, not an error to retry. */
export async function removeEvent(api, calendarId, change, markRemoving) {
  const record = change.record;
  const eventId = record.eventId || change.id;
  const gone = () => record.removing ? { removed: true } : { deleted: true };
  let existing;
  try {
    existing = await api.getEvent(calendarId, eventId);
  } catch (e) {
    if (e.status === 404) return { removed: true };
    if (e.status === 410) return gone();
    throw e;
  }
  if (existing.status === "cancelled") return gone();
  if (!record.key || existing.extendedProperties?.private?.watnow !== "1" || existing.extendedProperties.private.watnowKey !== record.key) {
    throw calendarError("ownership", "An event couldn't be identified as a WATnow deadline. Sync is paused.");
  }
  // Save intent before DELETE: a lost response must not turn our own removal
  // into a permanent Google-deletion tombstone after the worker restarts.
  await markRemoving();
  try {
    await api.deleteEvent(calendarId, eventId);
  } catch (e) {
    if (e.status !== 404 && e.status !== 410) throw e;
  }
  return { removed: true };
}

export async function scheduleCalendarRetry(minutes = 1) {
  await chrome.alarms.create(CALENDAR_ALARM, { when: Date.now() + minutes * 60000 });
}

export async function requestCalendarSync() {
  if (!googleConfigured()) return;
  const c = await updateCalendarState((s) => {
    if (!s.enabled) return false;
    s.pending = true;
    s.revision++;
  });
  if (!c.enabled || ["connecting", "reconnect", "error"].includes(c.status)) return;
  // Persist the wake-up before starting network work. Workers can stop anytime.
  await scheduleCalendarRetry();
  runCalendarSync();
}

/** Safe on every worker wake: a stuck "connecting" means the previous worker
 * died mid-auth, so the only recovery is to ask the user to reconnect. Pure
 * storage, no network, since this runs far more often than the browser
 * actually restarts. */
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

/** Only call this on a real browser startup or extension install/update, not
 * on routine worker wake-ups: chrome.alarms persists CALENDAR_ALARM across
 * those on its own, so a plain restart doesn't need this. This is the
 * fallback for when that alarm didn't survive (e.g. the first wake after
 * enabling sync, or an update that cleared alarms). */
export async function recoverCalendarSync() {
  const c = await getCalendarState();
  if (c.enabled && !["connecting", "reconnect", "error"].includes(c.status)) await requestCalendarSync();
}

/** The old destination is paused before authorization begins. Cancelling
 * cannot silently resume writes to an account the user meant to replace. */
export async function connectCalendar({ changeAccount = false } = {}) {
  if (!googleConfigured()) return { ok: false, reason: configurationError("Missing OAuth client ID").message };
  if (changeAccount) {
    return { ok: false, reason: "Disconnect Calendar first, then connect using the Google account available in Chrome." };
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
    const { account } = await connectGoogle(before.account);
    const c = await updateCalendarState((s) => {
      if (s.generation !== start.generation) return false;
      s.account = account;
      s.accounts[account.id] ||= { calendarId: null, events: {} };
      if (s.accounts[account.id].missing) s.accounts[account.id] = { calendarId: null, events: {} };
      // Only an explicit reconnect permits another creation attempt after an
      // uncertain response. Background retries must not create duplicates.
      delete s.accounts[account.id].creatingAt;
      s.enabled = true;
      // Explicitly opting in from Settings brings the shortcut back.
      s.dismissed = false;
      s.status = "ready";
      s.lastSyncAt = null;
      s.attempts = 0;
    });
    if (c.generation !== start.generation) return { ok: false, reason: "Connection cancelled." };
    await requestCalendarSync();
    return { ok: true };
  } catch (e) {
    const message = calendarMessage(e);
    await updateCalendarState((s) => {
      if (s.generation !== start.generation) return false;
      s.status = "off";
      s.error = message;
    });
    return { ok: false, reason: message };
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
  if (!googleConfigured()) return;
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
    if (!calendarId) {
      if (record.creatingAt) {
        throw calendarError("setup", "Calendar setup was interrupted. Check Google Calendar before reconnecting; reconnecting may create another WATNOW calendar.");
      }
      await save((_s, r) => { r.creatingAt = new Date().toISOString(); });
      const created = await api.createCalendar();
      if (!created.id) throw calendarError("setup", "Calendar setup was interrupted. Check Google Calendar before reconnecting; reconnecting may create another WATNOW calendar.");
      calendarId = created.id;
      await guard();
      await save((_s, r) => { r.calendarId = calendarId; delete r.creatingAt; });
    }
    // A missing calendar must never turn into hundreds of attempted inserts.
    try {
      const destination = await api.getCalendar(calendarId);
      if (destination.description !== CALENDAR_MARKER) throw calendarError("ownership", "This calendar couldn't be identified as WATnow's. Sync is paused.");
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
      await save((_s, r) => { r.missing = true; });
      throw calendarError("calendar-missing", "The WATNOW calendar is missing. Reconnect to create a new one.");
    }
    const plan = await calendarPlan(state, settings.school, record.events);
    const started = Date.now();
    let done = 0;
    for (const change of plan) {
      if (done >= 20 || Date.now() - started > 25000) break;
      await guard();
      if (change.remove) {
        const result = await removeEvent(api, calendarId, change, async () => {
          await guard();
          await save((_s, r) => { r.events[change.id] = { ...change.record, removing: true }; });
        });
        await guard();
        await save((_s, r) => {
          const { removing, fingerprint, ...metadata } = change.record;
          r.events[change.id] = { ...metadata, ...result };
        });
      } else {
        const result = await reconcileEvent(api, calendarId, change);
        await guard();
        await save((_s, r) => { r.events[change.id] = { ...change.metadata, ...result }; });
      }
      done++;
    }
    await guard();
    const next = await save((s) => {
      s.pending = done < plan.length || s.revision !== c.revision || plan.some((change) => change.remove);
      s.status = s.pending ? "queued" : "ready";
      s.attempts = 0;
      if (!s.pending) s.lastSyncAt = new Date().toISOString();
    });
    if (next.pending) await scheduleCalendarRetry(0.5);
    else {
      await chrome.alarms.clear(CALENDAR_ALARM);
      // A newer state change can arrive while the alarm is being cleared.
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
      const retry = e.retry && !(e.code === "token" && s.attempts >= 3);
      s.status = retry ? "queued" : ["auth", "token"].includes(e.code) ? "reconnect" : "error";
      s.error = calendarMessage(e);
      s.pending = true;
    });
    if (next.generation !== generation) return;
    if (next.status === "queued") await scheduleCalendarRetry(Math.min(60, 2 ** Math.min(next.attempts, 6)));
    else await chrome.alarms.clear(CALENDAR_ALARM);
  }
}
