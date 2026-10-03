// DEMO mode: builds a fake copy of Learn from fixtures.js and serves it with
// realistic delays. The "catalog" is what Learn itself holds. WATnow's own
// state is filled by reading the catalog, the same way LIVE mode reads Learn.

import { STUDENT, TERM, COURSES, ITEMS, DEMO_SCRIPT } from "./fixtures.js";
import { addDays, startOfDay, parseClock, MINUTE } from "../core/dates.js";

export function learnUrl(base, course, item) {
  const b = (base || "http://localhost:8080").replace(/\/$/, "");
  const ou = course.orgUnitId;
  const sid = encodeURIComponent(item.id);
  switch (item.kind) {
    case "dropbox":
      return `${b}/d2l/lms/dropbox/user/folder_submit_files.html?ou=${ou}&db=${sid}`;
    case "quiz":
      return `${b}/d2l/lms/quizzing/user/quiz_summary.html?ou=${ou}&qi=${sid}`;
    case "discussion":
      return `${b}/d2l/le/discussions/topic.html?ou=${ou}&topicId=${sid}`;
    default:
      return `${b}/d2l/le/content/viewContent.html?ou=${ou}&topicId=${sid}`;
  }
}

export function courseHomeUrl(base, course) {
  const b = (base || "http://localhost:8080").replace(/\/$/, "");
  return `${b}/d2l/home/course.html?ou=${course.orgUnitId}`;
}

function resolveDue(due, now) {
  if (due.inMinutes != null) {
    const t = new Date(now.getTime() + due.inMinutes * MINUTE);
    t.setSeconds(0, 0);
    const rem = t.getMinutes() % 5;
    if (rem) t.setMinutes(t.getMinutes() + (5 - rem));
    return t;
  }
  const d = addDays(startOfDay(now), due.days || 0);
  const { h, m } = parseClock(due.at || "23:59");
  d.setHours(h, m, 0, 0);
  return d;
}

/** Materialize the fixture file into an absolute Learn catalog. */
export function buildCatalog(settings, now = new Date()) {
  const base = settings.learnBase;
  const courses = COURSES.map((c) => ({ ...c }));
  const byId = Object.fromEntries(courses.map((c) => [c.id, c]));
  const items = ITEMS.map((it) => {
    const course = byId[it.course];
    const dueAt = resolveDue(it.due, now);
    const submittedAt = it.status === "submitted" ? new Date(Math.min(dueAt.getTime() - 26 * 60 * MINUTE, now.getTime() - 3 * 60 * MINUTE)) : null;
    return {
      id: it.id,
      courseId: it.course,
      kind: it.kind,
      category: it.category,
      title: it.title,
      details: it.details || "",
      dueAt: dueAt.toISOString(),
      url: learnUrl(base, course, it),
      status: it.status === "submitted" ? "submitted" : "open",
      completedAt: submittedAt ? submittedAt.toISOString() : null,
      moved: null,
    };
  });
  return {
    builtAt: now.toISOString(),
    builtDay: startOfDay(now).toISOString(),
    student: { ...STUDENT },
    term: TERM,
    learnBase: base,
    courses,
    items,
  };
}

export { DEMO_SCRIPT };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class DemoSource {
  constructor(settings, getCatalog) {
    this.mode = "demo";
    this.settings = settings;
    this.getCatalog = getCatalog;
  }
  async checkSession() {
    const cat = await this.getCatalog();
    return { signedIn: true, student: cat.student };
  }
  async listCourses() {
    await wait(260);
    const cat = await this.getCatalog();
    return cat.courses;
  }
  async listDeadlines(course, index = 0) {
    await wait(DEMO_SCRIPT.scanDelays[index % DEMO_SCRIPT.scanDelays.length]);
    const cat = await this.getCatalog();
    return cat.items.filter((i) => i.courseId === course.id).map((i) => ({ ...i }));
  }
}
