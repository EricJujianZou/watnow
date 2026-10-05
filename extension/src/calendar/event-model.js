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

/** Keep actual read results with the state they produced. The local list
 * treats disconnected Crowdmark as empty; that isn't evidence of deletion. */
export function calendarReadStatus(result, at) {
  const courses = Object.fromEntries([...result.readOk]
    .filter(([id]) => !result.failed.has(id))
    .map(([id, sources]) => [id, [...sources].filter((source) => source !== "crowdmark" || result.crowdmark.status === "ok")]));
  return { at, courses };
}

/** Removal needs a current course and a complete read of every source that
 * supplied the item. Missing courses, failed reads and old records are kept. */
function canRemove(state, courses, record) {
  const read = state.calendarRead;
  const ok = read?.courses?.[record.courseId];
  return state.scan?.status === "done" && !state.syncing && !state.stale &&
    read?.at === state.lastSyncAt && courses.has(record.courseId) &&
    record.key && record.seenIn?.length && Array.isArray(ok) && record.seenIn.every((source) => ok.includes(source));
}

/** Existing events keep receiving updates, including completed/overdue work.
 * Only new events are limited to upcoming, open deadlines. Source removals
 * can return; Google deletions stay deleted. Records use a stable logical ID,
 * while each republish gets a new Google ID to avoid Google's tombstones. */
export async function calendarPlan(state, school, records, now = Date.now()) {
  const courses = new Map(state.courses.map((c) => [c.id, c]));
  const plan = [];
  const liveIds = new Set();
  for (const item of state.items) {
    const key = deadlineKey(school, item);
    const id = await eventIdFor(key);
    liveIds.add(id);
    const course = courses.get(item.courseId);
    if (!course || !Number.isFinite(Date.parse(item.dueAt))) continue;
    const previous = records[id];
    if (previous?.deleted) continue;
    if (previous?.removing) {
      // Finish an interrupted removal before recreating the event, even if
      // the item came back while the delete response was in flight.
      if (canRemove(state, courses, previous)) plan.push({ id, remove: true, record: previous });
      continue;
    }
    if (!previous && (item.status !== "open" || Date.parse(item.dueAt) <= now)) continue;
    const incarnation = (previous?.incarnation || 0) + (previous?.removed ? 1 : 0);
    const eventId = incarnation ? await eventIdFor(`${key}:republished:${incarnation}`) : id;
    const metadata = { school, courseId: item.courseId, seenIn: item.seenIn || [], key, eventId, incarnation };
    const event = deadlineToEvent(item, course, key);
    const fingerprint = eventFingerprint(event);
    if (previous?.removed || previous?.fingerprint !== fingerprint || previous?.courseId !== item.courseId || JSON.stringify(previous?.seenIn) !== JSON.stringify(metadata.seenIn)) {
      plan.push({ id, eventId, event, fingerprint, metadata });
    }
  }
  for (const [id, record] of Object.entries(records)) {
    if (record.deleted || record.removed || record.school !== school || liveIds.has(id)) continue;
    if (canRemove(state, courses, record)) plan.push({ id, remove: true, record });
  }
  return plan;
}
