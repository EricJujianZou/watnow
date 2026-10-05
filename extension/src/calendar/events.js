/*
  Deadlines as calendar events.

  This is the part every calendar has in common. It turns the Deadline and
  Course objects the rest of WATnow already works with into plain event
  objects, and works out what changed since the last sync. Nothing here knows
  about iCalendar or about Google: a calendar is whatever can create, change
  and delete events, the same way a DeadlineSource is whatever can list
  deadlines. See src/calendar/ics.js for the first one.

  An event ends at the due time and runs for half an hour before it, so the
  block finishes exactly when the work is due and an 11:59 pm deadline stays
  on its own day instead of crossing midnight.

  Each event carries a uid built from the deadline's own id, which Learn and
  Crowdmark both keep stable between reads. That is what lets a second sync
  change the event that is already there rather than adding another copy of it.

  A fingerprint covers everything a calendar would show. Equal fingerprints
  mean there is nothing to send, which keeps a check that found no changes
  from writing anything at all.

  Handing work in does not take it off the calendar: the event stays with a
  check mark on the title, so the student keeps a record of what they handed in
  and when. A deadline that disappears is a deletion, and it is remembered for
  a while afterwards so a calendar that only sees whole files can be told about
  it too.
*/

/** How long before the due time the event starts. */
export const BLOCK_MINUTES = 30;

/** The name of the calendar WATnow keeps its events in. */
export const CALENDAR_NAME = "WATnow deadlines";

const UID_HOST = "watnow.ugmi.ca";
const DONE_MARK = "✓ ";
const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a deleted deadline is still mentioned, for calendars that read whole files. */
export const TOMBSTONE_MS = 30 * DAY_MS;

const CATEGORY_LABEL = {
  assignment: "Assignment",
  lab: "Lab",
  quiz: "Quiz",
  discussion: "Discussion",
  content: "Content",
};

/** Stays the same for an item between reads, so a second sync updates rather than duplicates. */
export function uidFor(itemId) {
  const safe = String(itemId).replace(/[^A-Za-z0-9._-]/g, "-");
  return `watnow-${safe}@${UID_HOST}`;
}

const handedIn = (item) => item.status === "submitted" || item.status === "done";

export function titleFor(item, course) {
  const code = course && course.code ? `${course.code}: ` : "";
  return `${handedIn(item) ? DONE_MARK : ""}${code}${item.title}`;
}

function describe(item, course) {
  const lines = [];
  const kind = CATEGORY_LABEL[item.category] || "Item";
  lines.push(item.kind === "crowdmark" ? `${kind} on Crowdmark` : kind);
  if (course && course.name) lines.push(course.name);
  if (handedIn(item)) {
    const at = item.completedAt ? new Date(item.completedAt) : null;
    lines.push(item.status === "submitted" ? `Submitted${at ? ` ${at.toLocaleString()}` : ""}` : "Checked off in WATnow");
  }
  if (item.opensAt) lines.push(`Opens ${new Date(item.opensAt).toLocaleString()}`);
  if (item.url) lines.push(item.url);
  lines.push("Added by WATnow.");
  return lines.join("\n");
}

/**
 * One deadline as an event, or null when it has no date a calendar could use.
 * @param {object} item     Deadline
 * @param {object} [course] The course it belongs to, for the code on the title
 */
export function buildEvent(item, course) {
  const due = Date.parse(item.dueAt);
  if (!Number.isFinite(due)) return null;
  const end = new Date(due);
  const start = new Date(due - BLOCK_MINUTES * 60000);
  const title = titleFor(item, course);
  const description = describe(item, course);
  return {
    uid: uidFor(item.id),
    itemId: item.id,
    courseId: item.courseId,
    title,
    description,
    url: item.url || "",
    start,
    end,
    status: item.status,
    // Everything a calendar would show. Equal means there is nothing to send.
    fingerprint: `${title}|${end.toISOString()}|${description}|${item.url || ""}`,
  };
}

/**
 * Every dated deadline as an event, oldest first.
 * @param {Array} items
 * @param {Array} courses
 */
export function buildEvents(items, courses) {
  const byId = new Map((courses || []).map((c) => [c.id, c]));
  return (items || [])
    .map((item) => buildEvent(item, byId.get(item.courseId)))
    .filter(Boolean)
    .sort((a, b) => a.end - b.end);
}

/**
 * What a calendar needs doing to catch up.
 *
 * `index` is what was last synced: uid -> { fingerprint, seq, eventId, title,
 * start, removedAt }. title and start are kept so an item that later disappears
 * can be cancelled properly, when WATnow no longer has the deadline itself.
 * eventId is whatever the calendar calls the event it made, so an update can
 * name it; a calendar that takes whole files leaves it null.
 *
 * @returns {{creates: Array, updates: Array, deletes: Array, index: object, changed: boolean}}
 */
export function planSync(index, events, now = new Date()) {
  const prev = index || {};
  const at = now.getTime();
  const creates = [];
  const updates = [];
  const deletes = [];
  const next = {};
  const live = new Set();

  for (const ev of events) {
    live.add(ev.uid);
    const was = prev[ev.uid];
    if (!was || was.removedAt) {
      // New, or back after being deleted: a fresh sequence either way.
      const seq = was ? (was.seq || 0) + 1 : 0;
      next[ev.uid] = { fingerprint: ev.fingerprint, seq, eventId: (was && was.eventId) || null, title: ev.title, start: ev.start.toISOString() };
      creates.push({ ...ev, seq, eventId: next[ev.uid].eventId });
    } else if (was.fingerprint !== ev.fingerprint) {
      const seq = (was.seq || 0) + 1;
      next[ev.uid] = { fingerprint: ev.fingerprint, seq, eventId: was.eventId || null, title: ev.title, start: ev.start.toISOString() };
      updates.push({ ...ev, seq, eventId: was.eventId || null });
    } else {
      next[ev.uid] = { ...was };
    }
  }

  for (const [uid, was] of Object.entries(prev)) {
    if (live.has(uid)) continue;
    if (was.removedAt) {
      // Keep saying it is gone for a while, for a calendar that reads whole files.
      if (at - Date.parse(was.removedAt) < TOMBSTONE_MS) next[uid] = was;
      continue;
    }
    const seq = (was.seq || 0) + 1;
    next[uid] = { ...was, seq, removedAt: now.toISOString() };
    deletes.push({ uid, seq, eventId: was.eventId || null });
  }

  return { creates, updates, deletes, index: next, changed: creates.length + updates.length + deletes.length > 0 };
}

/**
 * The removals a calendar that reads whole files still needs telling about:
 * everything deleted inside the tombstone window, as events it can cancel.
 */
export function tombstones(index, now = new Date()) {
  const at = now.getTime();
  return Object.entries(index || {})
    .filter(([, e]) => e.removedAt && at - Date.parse(e.removedAt) < TOMBSTONE_MS)
    .map(([uid, e]) => ({ uid, seq: e.seq || 0, title: e.title || "Removed", start: e.start ? new Date(e.start) : new Date(at) }));
}
