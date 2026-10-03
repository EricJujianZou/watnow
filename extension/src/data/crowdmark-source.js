/*
  Crowdmark reader.

  Crowdmark has no documented student API. This reads the two addresses its own
  student pages call, with the session already in the browser, and only after
  the student gave WATnow access to app.crowdmark.com. It never writes anything.

  GET /api/v2/student/courses?include[]=course-archivation
      data[]: id is a slug ("ece-207-fall-2026"), attributes.name is
      "ECE 207 - Fall 2026". There is no term field, and old courses are often
      not archived, so the term comes from the name.
  GET /api/v2/student/assignments?filter[course]=<slug>
      data[]: id is a uuid. attributes: due (UTC ISO, null for a proctored
      exam), submitted-at, is-locked, penalty-period, penalty-value. The title
      and type sit on the included exam-masters record.

  Which courses are read: the current term's, plus courses with no term in the
  name when their code matches a Learn course. Other terms are skipped, so a
  normal check makes one request per current Crowdmark course.

  A Crowdmark course whose code matches a Learn course puts its items under
  that Learn course. One with no match becomes a course of its own, with the
  id "cm:<slug>" and crowdmark: true.

  Items carry kind "crowdmark" and seenIn ["crowdmark"]. The caller adds
  "crowdmark" to readOk for every course that read completely, so mergeLive
  keeps stored Crowdmark items when Crowdmark could not be read.
*/

import { termCodeFor, termFromText } from "./live-source.js";
import { DEFAULT_SCHOOL } from "../core/schools.js";

export const CROWDMARK_BASE = "https://app.crowdmark.com";
export const CROWDMARK_ORIGIN = `${CROWDMARK_BASE}/*`;
export const CROWDMARK_SIGN_IN = `${CROWDMARK_BASE}/sign-in/waterloo`;

const TIMEOUT_MS = 20000;
const GAP_MS = 150;
const MAX_COURSES = 12;

const COURSES_PATH = "/api/v2/student/courses?include[]=course-archivation";
const assignmentsPath = (slug) =>
  `/api/v2/student/assignments?fields[exam-masters][]=type&fields[exam-masters][]=title&filter[course]=${encodeURIComponent(slug)}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** settings.crowdmarkBaseOverride exists only so the local test mock can stand in, and only localhost is accepted. */
export function crowdmarkBase(settings) {
  const o = settings && settings.crowdmarkBaseOverride;
  if (o) {
    try {
      const u = new URL(o);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
    } catch {
      /* ignore a bad override */
    }
  }
  return CROWDMARK_BASE;
}

/**
 * True once the student gave WATnow access to Crowdmark. Crowdmark is Waterloo
 * only, so a student who switched to another school reads none of it, even with
 * the permission still granted.
 */
export async function crowdmarkAllowed(settings) {
  if (settings && settings.school && settings.school !== DEFAULT_SCHOOL) return false;
  try {
    return await chrome.permissions.contains({ origins: [`${crowdmarkBase(settings)}/*`] });
  } catch {
    return false;
  }
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function getJson(base, path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base + path, {
      credentials: "include",
      headers: { Accept: "application/vnd.api+json, application/json" },
      signal: ctl.signal,
    });
  } catch (e) {
    throw fail("unreachable", String((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }
  const type = res.headers.get("content-type") || "";
  // Signed out has not been seen on a real account yet. A sign-in redirect, a
  // 401 or 403, and an HTML page where JSON belongs all count as signed out.
  const onSignIn = res.redirected && /sign[-_]?in|login/i.test(new URL(res.url).pathname);
  if (res.status === 401 || res.status === 403 || onSignIn) throw fail("signed-out", `Crowdmark ${res.status}`);
  if (!res.ok) throw fail("unreachable", `Crowdmark ${res.status}`);
  if (!/json/i.test(type)) throw fail("signed-out", "Crowdmark answered with a page");
  try {
    return await res.json();
  } catch {
    throw fail("unreachable", "Crowdmark sent unreadable JSON");
  }
}

const squash = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "ECE 207 - Fall 2026" gives { code: "ECE 207", term: 1269 }. */
export function parseCrowdmarkCourse(name, slug) {
  const text = String(name || "");
  const m = text.match(/^\s*([A-Za-z]{2,8})\s*[-_ ]?\s*(\d{2,3}[A-Za-z]?)\b/);
  const code = m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : text.trim().slice(0, 40);
  const term = termFromText(text) || termFromText(String(slug || "").replace(/-/g, " "));
  return { code, term, hasCode: !!m };
}

function categoryFor(title) {
  if (/^\s*lab\b/i.test(title)) return "lab";
  if (/\bquiz\b/i.test(title)) return "quiz";
  return "assignment";
}

function toItem(base, a, included, courseId, slug) {
  const at = a.attributes || {};
  const due = at.due && !Number.isNaN(Date.parse(at.due)) ? new Date(at.due).toISOString() : null;
  if (!due) return null;
  const ref = a.relationships && a.relationships["exam-master"] && a.relationships["exam-master"].data;
  const master = ref ? included.find((i) => i.type === ref.type && i.id === ref.id) : null;
  const title = (master && master.attributes && master.attributes.title) || "Crowdmark assignment";
  const submittedAt = at["submitted-at"] || null;
  const courseUrl = `${base}/student/courses/${encodeURIComponent(slug)}`;
  return {
    id: `cm:${a.id}`,
    courseId,
    kind: "crowdmark",
    category: categoryFor(title),
    title: String(title).trim(),
    dueAt: due,
    url: ref && ref.id ? `${base}/student/assessments/${encodeURIComponent(ref.id)}` : courseUrl,
    listUrl: courseUrl,
    status: submittedAt ? "submitted" : "open",
    completedAt: submittedAt,
    locked: at["is-locked"] === true,
    seenIn: ["crowdmark"],
  };
}

/**
 * Reads Crowdmark once.
 * @param {object} settings
 * @param {Array} learnCourses  The Learn courses of this read, to file Crowdmark items under
 * @param {Date} [now]
 * @returns {Promise<{status: "ok"|"signed-out"|"unreachable", courses: Array, items: Array, okCourseIds: Set<string>, failedCourseIds: Set<string>, report: object}>}
 */
export async function readCrowdmark(settings, learnCourses, now = new Date()) {
  const base = crowdmarkBase(settings);
  const out = { status: "ok", courses: [], items: [], okCourseIds: new Set(), failedCourseIds: new Set(), report: { at: now.toISOString() } };
  let list;
  try {
    list = await getJson(base, COURSES_PATH);
  } catch (e) {
    out.status = e.code === "signed-out" ? "signed-out" : "unreachable";
    out.report.error = e.message;
    return out;
  }
  const rows = Array.isArray(list && list.data) ? list.data : [];
  const current = termCodeFor(now);
  const byCode = new Map(learnCourses.map((c) => [squash(c.code), c]));
  const picked = [];
  for (const row of rows) {
    const arch = row.relationships && row.relationships["course-archivation"];
    if (arch && arch.data) continue;
    const parsed = parseCrowdmarkCourse(row.attributes && row.attributes.name, row.id);
    const learn = parsed.hasCode ? byCode.get(squash(parsed.code)) : null;
    if (parsed.term === current || (parsed.term == null && learn)) picked.push({ row, parsed, learn });
  }
  out.report.courses = { listed: rows.length, read: Math.min(picked.length, MAX_COURSES), matchedLearn: picked.filter((p) => p.learn).length };

  let failedCourses = 0;
  for (const { row, parsed, learn } of picked.slice(0, MAX_COURSES)) {
    const courseId = learn ? learn.id : `cm:${row.id}`;
    const own = learn
      ? null
      : {
          id: courseId,
          code: parsed.code,
          name: "",
          orgUnitId: 0,
          color: "mint",
          current: true,
          crowdmark: true,
          homeUrl: `${base}/student/courses/${encodeURIComponent(row.id)}`,
        };
    try {
      await wait(GAP_MS);
      const r = await getJson(base, assignmentsPath(row.id));
      const included = (r && r.included) || [];
      const items = (Array.isArray(r && r.data) ? r.data : []).map((a) => toItem(base, a, included, courseId, row.id)).filter(Boolean);
      out.items.push(...items);
      out.okCourseIds.add(courseId);
      if (own) out.courses.push(own);
    } catch (e) {
      if (e.code === "signed-out") {
        out.status = "signed-out";
        out.report.error = e.message;
        return out;
      }
      failedCourses += 1;
      out.failedCourseIds.add(courseId);
      // Listed so a course that was shown before is not dropped over one bad read.
      if (own) out.courses.push({ ...own, readFailed: true });
    }
  }
  out.report.items = out.items.length;
  out.report.failedCourses = failedCourses;
  if (picked.length && failedCourses === Math.min(picked.length, MAX_COURSES)) out.status = "unreachable";
  return out;
}

/**
 * Asks Crowdmark whether one assignment is handed in, right before a reminder
 * goes out. Resolves to { submitted, at }, or null when Crowdmark can't be asked.
 */
export async function crowdmarkSubmitted(settings, item) {
  const id = String(item.id || "").replace(/^cm:/, "");
  if (!id || !(await crowdmarkAllowed(settings))) return null;
  try {
    const r = await getJson(crowdmarkBase(settings), `/api/v2/student/assignments/${encodeURIComponent(id)}`);
    const at = r && r.data && r.data.attributes ? r.data.attributes["submitted-at"] : undefined;
    if (at === undefined) return null;
    return at ? { submitted: true, at } : { submitted: false };
  } catch {
    return null;
  }
}
