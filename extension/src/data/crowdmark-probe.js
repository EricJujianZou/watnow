/*
  Crowdmark test read, for the debug page in the development build only.

  Crowdmark has no documented student API. The two addresses below are the ones
  its own student pages call, as seen in open-source tools. This reads them once
  with the session already in the browser and reports what came back, so the
  real reader gets written against real responses.

  The report keeps course names, assignment titles and dates. It leaves out
  scores and anything about the student.
*/

import { CROWDMARK_BASE, CROWDMARK_ORIGIN } from "./crowdmark-source.js";

export { CROWDMARK_BASE, CROWDMARK_ORIGIN };

const COURSES_PATH = "/api/v2/student/courses?include[]=course-archivation";
const assignmentsPath = (courseId) =>
  `/api/v2/student/assignments?fields[exam-masters][]=type&fields[exam-masters][]=title&filter[course]=${encodeURIComponent(courseId)}`;

const MAX_COURSES = 8;
const TIMEOUT_MS = 20000;
const DATE_HINT = /due|late|lock|penal|clos|open|start|end|submit/i;

async function read(path) {
  const out = { path: path.split("?")[0] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CROWDMARK_BASE + path, {
      credentials: "include",
      headers: { Accept: "application/vnd.api+json, application/json" },
      signal: ctl.signal,
    });
    out.status = res.status;
    out.redirected = res.redirected;
    out.endedAt = new URL(res.url).pathname;
    out.contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    out.bytes = text.length;
    try {
      out.json = JSON.parse(text);
    } catch {
      out.json = null;
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

const keys = (o) => (o && typeof o === "object" ? Object.keys(o) : []);
const meta = ({ json, ...rest }) => ({ ...rest, gotJson: json !== null && json !== undefined });

function courseRow(c) {
  const a = c.attributes || {};
  const arch = c.relationships && c.relationships["course-archivation"];
  return {
    id: c.id,
    name: a.name,
    archived: !!(arch && arch.data),
    examMasterCount: a["exam-master-count"],
    attributeKeys: keys(a),
    relationshipKeys: keys(c.relationships),
  };
}

function assignmentRow(a, included) {
  const at = a.attributes || {};
  const ref = a.relationships && a.relationships["exam-master"] && a.relationships["exam-master"].data;
  const master = ref ? included.find((i) => i.type === ref.type && i.id === ref.id) : null;
  const dates = {};
  for (const k of keys(at)) if (DATE_HINT.test(k)) dates[k] = at[k];
  return {
    id: a.id,
    title: master && master.attributes ? master.attributes.title : null,
    type: master && master.attributes ? master.attributes.type : null,
    dates,
    scored: at["normalized-points"] !== undefined && at["normalized-points"] !== 0,
    links: a.links || null,
  };
}

/** @param {"page"|"worker"} from  Where the read ran, since the two may carry the session differently. */
export async function probeCrowdmark(from) {
  const report = { from, at: new Date().toISOString(), courses: null, courseList: [], assignments: [] };
  const c = await read(COURSES_PATH);
  report.courses = meta(c);
  if (!c.json || !Array.isArray(c.json.data)) return report;

  report.courseList = c.json.data.map(courseRow);
  report.includedTypes = [...new Set((c.json.included || []).map((i) => i.type))];

  const active = report.courseList.filter((x) => !x.archived).slice(0, MAX_COURSES);
  for (const course of active) {
    const r = await read(assignmentsPath(course.id));
    const data = r.json && Array.isArray(r.json.data) ? r.json.data : [];
    const included = (r.json && r.json.included) || [];
    report.assignments.push({
      course: course.name,
      ...meta(r),
      attributeKeys: data[0] ? keys(data[0].attributes) : [],
      relationshipKeys: data[0] ? keys(data[0].relationships) : [],
      topLevelKeys: keys(r.json),
      items: data.map((a) => assignmentRow(a, included)),
    });
  }
  return report;
}
