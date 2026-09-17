// Reminder planning and notification copy.
// Rules: reminders only go out for open items, stop once Learn shows a
// submission or the student marks it done, and skip muted courses.

import { HOUR, DAY, dayDiff, fmtTime, fmtWeekday, fmtDate, fmtUntil, sameDay } from "./dates.js";

export const LEADS = [
  { id: "2d", label: "2 days before" },
  { id: "morning", label: "Morning of" },
  { id: "2h", label: "2 hours before" },
];

export const REMINDER_TYPES = [
  { id: "assignment", label: "Assignments" },
  { id: "lab", label: "Labs" },
  { id: "quiz", label: "Quizzes" },
  { id: "discussion", label: "Discussions" },
  { id: "content", label: "Other items" },
];

export function fmtHour(h) {
  const suffix = h >= 12 && h < 24 ? "pm" : "am";
  const hh = h % 12 || 12;
  return `${hh} ${suffix}`;
}

function leadTime(leadId, due) {
  const d = new Date(due);
  if (leadId === "2d") return new Date(d.getTime() - 2 * DAY);
  if (leadId === "2h") return new Date(d.getTime() - 2 * HOUR);
  if (leadId === "morning") {
    const m = new Date(d);
    m.setHours(8, 0, 0, 0);
    return m;
  }
  return null;
}

export function inQuietHours(date, settings) {
  const { quietStart, quietEnd } = settings.reminders;
  const h = date.getHours() + date.getMinutes() / 60;
  if (quietStart === quietEnd) return false;
  if (quietStart > quietEnd) return h >= quietStart || h < quietEnd;
  return h >= quietStart && h < quietEnd;
}

/** Move a time that falls in quiet hours to 30 minutes before quiet hours start. */
export function outOfQuietHours(date, settings) {
  if (!inQuietHours(date, settings)) return date;
  const { quietStart } = settings.reminders;
  const x = new Date(date);
  const beforeStart = x.getHours() + x.getMinutes() / 60 >= quietStart;
  if (!beforeStart) x.setDate(x.getDate() - 1);
  x.setHours(0, quietStart * 60 - 30, 0, 0);
  return x;
}

/**
 * Every reminder that should still go out, soonest first.
 * @returns {{key: string, itemId: string, lead: string, fireAt: Date}[]}
 */
export function plannedReminders(items, settings, now = new Date()) {
  const muted = new Set(settings.reminders.mutedCourses);
  const out = [];
  for (const item of items) {
    if (item.status !== "open" || muted.has(item.courseId)) continue;
    const due = new Date(item.dueAt);
    if (due <= now) continue;
    const leads = settings.reminders.leads[item.category] || [];
    const seen = new Set();
    for (const lead of leads) {
      const raw = leadTime(lead, due);
      if (!raw) continue;
      const fireAt = raw;
      if (fireAt >= due) continue;
      const stamp = Math.round(fireAt.getTime() / 60000);
      if (seen.has(stamp)) continue;
      seen.add(stamp);
      out.push({ key: `${item.id}:${lead}:${item.dueAt}`, itemId: item.id, lead, fireAt });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

const PENDING = {
  assignment: "you haven't submitted it yet",
  lab: "you haven't submitted it yet",
  quiz: "you haven't started an attempt yet",
  discussion: "you haven't posted yet",
  content: "it isn't marked complete yet",
};

/** Notification text for a reminder. Always names the course and the item. */
export function reminderCopy(item, course, now = new Date()) {
  const due = new Date(item.dueAt);
  const name = `${course.code} ${item.title}`;
  const closes = item.category === "quiz";
  const verb = closes ? "closes" : "is due";
  const ms = due - now;
  const days = dayDiff(due, now);
  const time = fmtTime(due);

  let title;
  if (ms <= 3 * HOUR) title = `${name} ${verb} ${fmtUntil(due, now)}`;
  else if (days === 0) title = `${name} ${verb} ${due.getHours() >= 18 ? "tonight" : "today"}`;
  else if (days === 1) title = `${name} ${verb} tomorrow`;
  else title = `${name} ${verb} in ${days} days`;

  let when;
  if (days === 0) when = `at ${time}`;
  else if (days === 1) when = `tomorrow at ${time}`;
  else if (days < 7) when = `${fmtWeekday(due)} at ${time}`;
  else when = `${fmtDate(due)} at ${time}`;

  const lead = closes ? `It closes ${when}` : `It's due ${when}`;
  return { title, message: `${lead} and ${PENDING[item.category] || PENDING.content}.` };
}

/** Notification text for a due date that changed on Learn. */
export function movedCopy(item, course, fromIso) {
  const to = new Date(item.dueAt);
  const from = new Date(fromIso);
  const sameTime = to.getHours() === from.getHours() && to.getMinutes() === from.getMinutes();
  const fromLabel = sameTime ? fmtDate(from) : `${fmtDate(from)} at ${fmtTime(from)}`;
  const verb = item.category === "quiz" ? "Now closes" : "Now due";
  return {
    title: `Your ${course.code} prof moved ${item.title}`,
    message: `${verb} ${fmtDate(to)} at ${fmtTime(to)} instead of ${fromLabel}.`,
  };
}

export { sameDay };
