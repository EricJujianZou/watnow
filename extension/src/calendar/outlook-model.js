// Pure conversion for Outlook: Learn/Crowdmark remain the source of the deadline time.

// A named single-value extended property tags each WATnow event with its
// deadline key, so a lost record can still find its event. Fixed forever: a new
// GUID would orphan every event already synced.
export const WATNOW_PROP = "String {45dd3fa2-9b34-4634-bc59-5baa16b7a199} Name watnowKey";

/** Graph's dateTimeTimeZone wants a bare local time ("2017-04-15T12:00:00")
 * with the zone named separately, so drop the Z and say UTC. */
function graphTime(ms) {
  return { dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: "UTC" };
}

export function outlookEvent(item, course, key) {
  const due = Date.parse(item.dueAt);
  const status = item.status === "submitted" ? "Submitted" : item.status === "done" ? "Checked off" : "Open";
  return {
    subject: `${item.status === "open" ? "" : "✓ "}${course.code} · ${item.title} due`,
    body: {
      contentType: "text",
      content: `${status}\n${course.code}${course.name ? ` · ${course.name}` : ""}\n\n${item.url || ""}\n\nSynced by WATnow. Deadline changes on your course site update this event.`,
    },
    start: graphTime(due),
    end: graphTime(due + 60 * 1000),
    // A deadline isn't a meeting: don't block the student's time
    showAs: "free",
    // WATnow sends its own reminders
    isReminderOn: false,
    singleValueExtendedProperties: [{ id: WATNOW_PROP, value: key }],
  };
}

/** Only what the student sees, so tagging details never force a rewrite. */
export function outlookFingerprint(event) {
  return JSON.stringify([
    event.subject,
    event.body?.contentType,
    event.body?.content,
    event.start?.dateTime,
    event.start?.timeZone,
    event.end?.dateTime,
    event.end?.timeZone,
  ]);
}

/** Graph dedupes a retried create that carries the same transactionId. Its docs
 * use a GUID, so this derives a GUID-shaped id from the key: four seeded 32-bit
 * hashes (128 bits), synchronous so callers needn't await it. */
export function transactionIdFor(key) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
