// Pure conversion: Learn/Crowdmark remain the source of the deadline time.
export function deadlineKey(school, item) {
  return `${school}:${item.id}`;
}

/** Hex is a subset of Google's base32hex event-id alphabet. A changed due
 * date keeps the same ID, and republishing a removed item uses an incremented
 * version so Google's cancelled event cache does not block re-insertion. */
export async function eventIdFor(key, version = 0) {
  const raw = version > 0 ? `${key}:v${version}` : key;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return `a${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function deadlineToEvent(item, course, key) {
  const due = new Date(item.dueAt);
  const status = item.status === "submitted" ? "Submitted" : item.status === "done" ? "Checked off" : "Open";
  return {
    summary: `${item.status === "open" ? "" : "✓ "}${course.code} · ${item.title} due`,
    description: `${status}\n${course.code}${course.name ? ` · ${course.name}` : ""}\n\n${item.url || ""}\n\nSynced by WATnow. Deadline changes on your course site update this event.`,
    start: { dateTime: due.toISOString() },
    end: { dateTime: new Date(due.getTime() + 60 * 1000).toISOString() },
    transparency: "transparent",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { watnowKey: key, watnow: "1" } },
  };
}

export function eventFingerprint(event) {
  return JSON.stringify(event);
}

/** Existing events keep receiving updates, including completed/overdue work.
 * Only new events are limited to upcoming, open deadlines. An item that's no
 * longer in state gets its event removed only when the course is still active
 * (so end of term or dropped courses do not wipe past calendar events). */
export async function calendarPlan(state, school, records = {}, now = Date.now()) {
  const courses = new Map(state.courses.map((c) => [c.id, c]));
  const plan = [];
  const liveIds = new Set();

  const recordsByKey = new Map();
  for (const [id, rec] of Object.entries(records)) {
    if (rec.key) recordsByKey.set(rec.key, { id, ...rec });
  }

  for (const item of state.items) {
    const course = courses.get(item.courseId);
    if (!course || !Number.isFinite(Date.parse(item.dueAt))) continue;
    const key = deadlineKey(school, item);

    const baseId = await eventIdFor(key, 0);
    const prevByKey = recordsByKey.get(key);
    const previous = prevByKey || records[baseId];

    // User explicitly deleted the event in Google Calendar: respect their deletion
    if (previous?.deleted) continue;

    const version = previous?.version || 0;
    const id = await eventIdFor(key, version);
    liveIds.add(id);
    if (previous?.id) liveIds.add(previous.id);

    if (!previous && (item.status !== "open" || Date.parse(item.dueAt) <= now)) continue;

    const event = deadlineToEvent(item, course, key);
    const fingerprint = eventFingerprint(event);

    if (previous?.removed || previous?.fingerprint !== fingerprint) {
      plan.push({ id, key, version, courseId: course.id, event, fingerprint });
    }
  }

  const activeCourseIds = new Set(state.courses.map((c) => c.id));
  for (const [id, record] of Object.entries(records)) {
    if (record.deleted || record.removed || record.school !== school) continue;
    // End of term or dropped course: keep finished and past events in Google Calendar
    if (record.courseId && !activeCourseIds.has(record.courseId)) continue;
    const recId = record.id || id;
    if (liveIds.has(recId) || (record.key && recordsByKey.has(record.key) && liveIds.has(recordsByKey.get(record.key).id))) continue;
    plan.push({ id: recId, key: record.key, courseId: record.courseId, remove: true });
  }

  return plan;
}
