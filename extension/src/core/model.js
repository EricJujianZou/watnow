// Turns stored state into what the panel shows: the verdict sentence, the
// trust line with item counts, and the bucketed rows.

import {
  addDays, bucketFor, dayDiff, endOfWeek, fmtDate, fmtDueDay, fmtLate, fmtRange, fmtShortDate,
  fmtTime, fmtUntil, fmtWeekdayShort, sameDay, startOfWeek, HOUR,
} from "./dates.js";
import { CATEGORY_LABEL, CATEGORY_PLURAL } from "../data/source.js";

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
  const week = open.filter((i) => !sameDay(i.dueAt, now) && new Date(i.dueAt) > now && new Date(i.dueAt) <= eow);
  const future = open.filter((i) => new Date(i.dueAt) >= now).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const course = (id) => courses.find((c) => c.id === id) || { code: "" };

  let headline;
  const t = today.length;
  const w = week.length;
  if (!open.length) headline = "Everything on Learn is handed in.";
  else if (t && w) headline = `You have ${plural(t, "thing", "things")} due today and ${w} more by Sunday.`;
  else if (t) headline = `You have ${plural(t, "thing", "things")} due today and nothing else this week.`;
  else if (w) headline = `Nothing is due today. You have ${plural(w, "thing", "things")} due by Sunday.`;
  else if (future.length) {
    const n = future[0];
    headline = `Nothing else is due this week. Next up is ${course(n.courseId).code} ${n.title} on ${fmtDate(n.dueAt)}.`;
  } else headline = "Nothing left to hand in right now.";

  let detail = null;
  if (overdue.length === 1) {
    const o = overdue[0];
    const day = fmtDueDay(o.dueAt, now);
    const when = day === "Yesterday" ? "yesterday" : day === "Today" ? "today" : `on ${fmtDate(o.dueAt)}`;
    detail = `${course(o.courseId).code} ${o.title} was due ${when} at ${fmtTime(o.dueAt)} and is still open.`;
  } else if (overdue.length > 1) {
    detail = `${overdue.length} things are past their due date and still open.`;
  }
  return { headline, detail, counts: { today: t, week: w, overdue: overdue.length } };
}

function joinList(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Found 23 items across 5 courses on Learn." or a per course breakdown. */
export function trustLine(items, courses, filter) {
  if (filter === "all") {
    return `Found ${plural(items.length, "deadline", "deadlines")} across ${plural(courses.length, "course", "courses")} on Learn.`;
  }
  const course = courses.find((c) => c.id === filter);
  const mine = items.filter((i) => i.courseId === filter);
  const order = ["assignment", "lab", "quiz", "discussion", "content"];
  const parts = order
    .map((cat) => [cat, mine.filter((i) => i.category === cat).length])
    .filter(([, n]) => n)
    .map(([cat, n]) => `${n} ${CATEGORY_PLURAL[cat][n === 1 ? 0 : 1]}`);
  return `Found ${plural(mine.length, "deadline", "deadlines")} in ${course ? course.code : "this course"}: ${joinList(parts)}.`;
}

function movedLabel(fromIso, due) {
  const from = new Date(fromIso);
  const sameTime = from.getHours() === due.getHours() && from.getMinutes() === due.getMinutes();
  return sameTime ? fmtDate(from) : `${fmtDate(from)} ${fmtTime(from)}`;
}

export function rowView(item, course, now) {
  const due = new Date(item.dueAt);
  const diff = dayDiff(due, now);
  const inWeek = due <= endOfWeek(now) && due >= startOfWeek(now);
  let dayShort;
  if (diff === 0) dayShort = "Today";
  else if (diff === -1) dayShort = "Yesterday";
  else if (inWeek || (diff < 0 && diff > -7)) dayShort = fmtWeekdayShort(due);
  else dayShort = fmtShortDate(due);
  let tone = "normal";
  let top = fmtDueDay(due, now);
  let bottom = fmtTime(due);
  const ms = due - now;

  if (item.status === "submitted") {
    tone = "submitted";
    top = "Submitted";
    bottom = `${dayShort} ${fmtTime(due)}`;
  } else if (item.status === "done") {
    tone = "done";
    top = "Done";
    bottom = `${dayShort} ${fmtTime(due)}`;
  } else if (ms < 0) {
    tone = "overdue";
    top = fmtLate(due, now);
    bottom = `${dayShort === "Today" ? "Today" : dayShort} ${fmtTime(due)}`;
  } else if (ms <= 3 * HOUR) {
    tone = "soon";
    const u = fmtUntil(due, now);
    top = u.charAt(0).toUpperCase() + u.slice(1);
    bottom = fmtTime(due);
  } else if (top.includes(",")) {
    bottom = fmtTime(due);
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
    bottom,
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
    trust: trustLine(all, courses, filter),
    groups: groups.filter((g) => g.rows.length),
    openInFilter: visible.filter((i) => i.status === "open" && bucketFor(i, now) !== "earlier").length,
    filterCourse: filter === "all" ? null : byId[filter] || null,
  };
}
