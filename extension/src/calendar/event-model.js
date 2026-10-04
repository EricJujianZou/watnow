// Pure conversion: Learn/Crowdmark remain the source of the deadline time.
export function deadlineKey(school, item) {
  return `${school}:${item.id}`;
}

/** Hex is a subset of Google's base32hex event-id alphabet. A changed due
 * date must keep the same ID, including after an interrupted insert. */
export async function eventIdFor(key) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
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
 * longer in state (deleted on the course site) gets its event removed. */
export async function calendarPlan(state, school, records, now = Date.now()) {
  const courses = new Map(state.courses.map((c) => [c.id, c]));
  const plan = [];
  const liveIds = new Set();
  for (const item of state.items) {
    const course = courses.get(item.courseId);
    if (!course || !Number.isFinite(Date.parse(item.dueAt))) continue;
    const key = deadlineKey(school, item);
    const id = await eventIdFor(key);
    liveIds.add(id);
    const previous = records[id];
    if (previous?.deleted) continue;
    if (!previous && (item.status !== "open" || Date.parse(item.dueAt) <= now)) continue;
    const event = deadlineToEvent(item, course, key);
    const fingerprint = eventFingerprint(event);
    if (previous?.fingerprint !== fingerprint) plan.push({ id, event, fingerprint });
  }
  // An item that drops out of state (deleted on the course site) no longer
  // has a record of its own school to re-derive, so each record remembers
  // the school it was synced under. Records from before that tagging existed
  // have no school on file and are left alone rather than guessed at.
  for (const [id, record] of Object.entries(records)) {
    if (record.deleted || record.school !== school || liveIds.has(id)) continue;
    plan.push({ id, remove: true });
  }
  return plan;
}
