// Date helpers. All display strings follow the writing rules: no dashes, plain words.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday 00:00 of the week containing d. */
export function startOfWeek(d) {
  const x = startOfDay(d);
  const offset = (x.getDay() + 6) % 7;
  return addDays(x, -offset);
}

/** Sunday 23:59:59.999 of the week containing d. */
export function endOfWeek(d) {
  const x = addDays(startOfWeek(d), 7);
  return new Date(x.getTime() - 1);
}

export function sameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function dayDiff(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / DAY);
}

export function fmtTime(d) {
  const x = new Date(d);
  let h = x.getHours();
  const m = x.getMinutes();
  const suffix = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Thu, Sep 17" */
export function fmtDate(d) {
  const x = new Date(d);
  return `${DAYS[x.getDay()]}, ${MONTHS[x.getMonth()]} ${x.getDate()}`;
}

/** "Sep 17" */
export function fmtShortDate(d) {
  const x = new Date(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()}`;
}

/** "Thu" */
export function fmtWeekdayShort(d) {
  return DAYS[new Date(d).getDay()];
}

export function fmtWeekday(d) {
  return DAYS_LONG[new Date(d).getDay()];
}

/** "Sep 15 to 20" or "Sep 28 to Oct 4" */
export function fmtRange(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  if (x.getMonth() === y.getMonth()) return `${MONTHS[x.getMonth()]} ${x.getDate()} to ${y.getDate()}`;
  return `${fmtShortDate(x)} to ${fmtShortDate(y)}`;
}

/** Label for the top line of the due column. */
export function fmtDueDay(due, now) {
  const diff = dayDiff(due, now);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return fmtDate(due);
}

/** "in 2 hours", "in 45 minutes", "in 1 hour" */
export function fmtUntil(due, now) {
  const ms = new Date(due) - new Date(now);
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 55) return `in ${Math.max(1, minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / HOUR);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** "1 day late", "3 days late", "5 hours late" */
export function fmtLate(due, now) {
  const ms = new Date(now) - new Date(due);
  const days = dayDiff(now, due);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} late`;
  const hours = Math.max(1, Math.round(ms / HOUR));
  return `${hours} hour${hours === 1 ? "" : "s"} late`;
}

/** "just now", "4 min ago", "2 hours ago" */
export function fmtAgo(then, now) {
  const ms = new Date(now) - new Date(then);
  if (ms < 45 * 1000) return "just now";
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(ms / HOUR);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return fmtDate(then);
}

/**
 * Which list section an item belongs in.
 * overdue: past due and still open
 * today, week (rest of this week through Sunday), next (next Monday to Sunday), later
 * earlier: past due and already handed in
 */
export function bucketFor(item, now) {
  const due = new Date(item.dueAt);
  const done = item.status !== "open";
  if (due < now) {
    if (!done) return "overdue";
    return sameDay(due, now) ? "today" : "earlier";
  }
  if (sameDay(due, now)) return "today";
  if (due <= endOfWeek(now)) return "week";
  if (due <= endOfWeek(addDays(now, 7))) return "next";
  return "later";
}

export function parseClock(s) {
  const [h, m] = String(s).split(":").map(Number);
  return { h: h || 0, m: m || 0 };
}
