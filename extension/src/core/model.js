// Turns stored state into what the panel shows: the two verdict lines and the
// bucketed rows.

import {
  addDays, bucketFor, dayDiff, endOfWeek, fmtDate, fmtDueDay, fmtLate, fmtRange, fmtShortDate,
  fmtTime, fmtUntil, sameDay, startOfWeek, HOUR,
} from "./dates.js";
import { CATEGORY_LABEL } from "../data/source.js";

export const BUCKETS = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "next", label: "Next week" },
  { id: "later", label: "Later" },
  { id: "earlier", label: "Handed in earlier" },
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function bucketSubtitle(id, now) {
  if (id === "today") return fmtDate(now);
  if (id === "week") return fmtRange(addDays(now, 1), endOfWeek(now));
  if (id === "next") {
    const s = addDays(startOfWeek(now), 7);
    return fmtRange(s, addDays(s, 6));
  }
  if (id === "later") return `After ${fmtShortDate(addDays(startOfWeek(now), 13))}`;
  return "";
}

export function verdict(items, courses, now) {
  const open = items.filter((i) => i.status === "open");
  const eow = endOfWeek(now);
  const overdue = open.filter((i) => new Date(i.dueAt) < now);
  const today = open.filter((i) => new Date(i.dueAt) >= now && sameDay(i.dueAt, now));
  const week = open
    .filter((i) => !sameDay(i.dueAt, now) && new Date(i.dueAt) > now && new Date(i.dueAt) <= eow)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const future = open.filter((i) => new Date(i.dueAt) >= now).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const course = (id) => courses.find((c) => c.id === id) || { code: "" };

  /** "tomorrow" or "Fri, Sep 25", for the "due by" line. */
  const byLabel = (d) => (dayDiff(d, now) === 1 ? "tomorrow" : fmtDate(d));

  const t = today.length;
  const w = week.length;
  let line1;
  let sleepy = false;
  if (!open.length) line1 = "Everything on Learn is handed in.";
  else if (t) line1 = `You have ${plural(t, "deadline", "deadlines")} due today.`;
  else {
    line1 = "Nothing due today";
    sleepy = true;
  }

  let line2 = null;
  if (w) {
    const last = week[week.length - 1].dueAt;
    line2 = t
      ? `You have ${plural(w, "more deadline", "more deadlines")} due by ${byLabel(last)}.`
      : `You have ${plural(w, "deadline", "deadlines")} due by ${byLabel(last)}.`;
  } else if (!t && future.length) {
    const n = future[0];
    line2 = `Next up is ${course(n.courseId).code} on ${fmtDate(n.dueAt)}.`;
  }

  let detail = null;
  if (overdue.length === 1) {
    const o = overdue[0];
    const day = fmtDueDay(o.dueAt, now);
    const when = day === "Yesterday" ? "yesterday" : day === "Today" ? "today" : `on ${fmtDate(o.dueAt)}`;
    detail = `${course(o.courseId).code} ${o.title} was due ${when} at ${fmtTime(o.dueAt)} and is still open.`;
  } else if (overdue.length > 1) {
    detail = `${overdue.length} deadlines are past their due date and still open.`;
  }
  return { line1, line2, sleepy, detail, counts: { today: t, week: w, overdue: overdue.length } };
}

function movedLabel(fromIso, due) {
  const from = new Date(fromIso);
  const sameTime = from.getHours() === due.getHours() && from.getMinutes() === due.getMinutes();
  return sameTime ? fmtDate(from) : `${fmtDate(from)} ${fmtTime(from)}`;
}

export function rowView(item, course, now) {
  const due = new Date(item.dueAt);
  // Some profs set a date the work unlocks. Until then Learn won't let you in,
  // so the row says when you can start.
  const opens = item.opensAt ? new Date(item.opensAt) : null;
  const opensNote = opens && opens > now && item.status === "open" ? fmtDueDay(opens, now) : null;
  let tone = "normal";
  let top = fmtDueDay(due, now);
  // Set when the top line is a status or a countdown, so the date still shows.
  let dateNote = null;
  const ms = due - now;

  if (item.status === "submitted") {
    tone = "submitted";
    top = "Submitted";
    dateNote = fmtDueDay(due, now);
  } else if (item.status === "done") {
    tone = "done";
    top = "Done";
    dateNote = fmtDueDay(due, now);
  } else if (ms < 0) {
    tone = "overdue";
    top = fmtLate(due, now);
    dateNote = fmtDueDay(due, now);
  } else if (ms <= 3 * HOUR) {
    tone = "soon";
    const u = fmtUntil(due, now);
    top = u.charAt(0).toUpperCase() + u.slice(1);
    dateNote = fmtDueDay(due, now);
  }

  return {
    id: item.id,
    courseId: item.courseId,
    code: course ? course.code : "",
    color: course ? course.color : "mint",
    type: CATEGORY_LABEL[item.category] || "Item",
    category: item.category,
    title: item.title,
    top,
    dateNote,
    opensNote,
    time: fmtTime(due),
    // Anything other than the usual 11:59 pm gets a highlighter blob behind it.
    timeOdd: !(due.getHours() === 23 && due.getMinutes() === 59),
    tone,
    status: item.status,
    movedFrom: item.moved ? movedLabel(item.moved.from, due) : null,
    url: item.url,
  };
}

export function buildModel(state, now, filter = "all") {
  const courses = state.courses || [];
  const byId = Object.fromEntries(courses.map((c) => [c.id, c]));
  const all = [...(state.items || [])].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const visible = filter === "all" ? all : all.filter((i) => i.courseId === filter);

  const groups = BUCKETS.map((b) => ({ ...b, subtitle: bucketSubtitle(b.id, now), rows: [] }));
  const index = Object.fromEntries(groups.map((g) => [g.id, g]));
  for (const item of visible) index[bucketFor(item, now)].rows.push(rowView(item, byId[item.courseId], now));
  index.earlier.rows.reverse();

  const counts = Object.fromEntries(courses.map((c) => [c.id, all.filter((i) => i.courseId === c.id).length]));
  return {
    courses,
    counts,
    total: all.length,
    verdict: verdict(all, courses, now),
    groups: groups.filter((g) => g.rows.length),
    openInFilter: visible.filter((i) => i.status === "open" && bucketFor(i, now) !== "earlier").length,
    filterCourse: filter === "all" ? null : byId[filter] || null,
  };
}
