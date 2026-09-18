/*
  LIVE mode: reads the student's own deadlines from Learn (D2L Brightspace).

  The requests use the Learn session the student already has in this browser.
  WATnow never sees a password and never talks to a server of its own. Results
  are stored in chrome.storage.local on this computer.

  Nothing here has been run against UW's Learn yet. Items marked VERIFY need a
  real student session to confirm. The "Copy debug info" button on the settings
  page reports what each request returned, so these can be checked.

  ------------------------------------------------------------------------
  1. API versions
     GET /d2l/api/versions/
       Returns [{ ProductCode: "lp", LatestVersion: "1.xx" }, { ProductCode: "le", ... }].
       Use the latest "lp" and "le" versions below as {lp} and {le}.

  2. Who is signed in (also the "signed out" check)
     GET /d2l/api/lp/{lp}/users/whoami
       200 with { FirstName, LastName, UniqueName } when signed in.
       401/403, an HTML page, or a redirect to /d2l/login means signed out.

  3. Courses
     GET /d2l/api/lp/{lp}/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true
       Paged: { PagingInfo: { Bookmark, HasMoreItems }, Items: [ MyOrgUnitInfo ] }.
       Keep items where Access.CanAccess is not false and the course is in the
       current term. The term comes from a UW term code (1269 is Fall 2026) or a
       "Fall 2026" style phrase in OrgUnit.Code or OrgUnit.Name, then from
       Access.StartDate/EndDate. UW uses Code "ECE203_pmitran_1269" and Name
       "ECE 203 - Fall 2026". Courses from other terms are dropped. Units with no
       term clue (Engineering Co-op Community and the like) are read but kept
       only if something in them is open and due from now on (keepTermless).
       Course.code/name come from OrgUnit.Name. On UW the name is just the code
       and term, so name is "" and the panel shows the code.

  4. Everything with a due date, across all courses
     Checked against docs.valence.desire2learn.com (res/content.html). Every
     myItems route needs orgUnitIdsCSV (at most 100 ids) and answers 400
     without it, which is what UW's Learn did on the first real test.
     GET /d2l/api/le/{le}/content/myItems/due/?orgUnitIdsCSV=1,2&startDateTime={utc}&endDateTime={utc}
     GET /d2l/api/le/{le}/content/myItems/?orgUnitIdsCSV=...&startDateTime=...&endDateTime=...
       Paged ObjectListPage { Objects, Next } of ScheduledItem:
       { OrgUnitId, ItemId, ItemName, ItemType, ItemUrl, StartDate, EndDate, DueDate,
         CompletionType, DateCompleted, ActivityType, IsExempt }
       ActivityType (CONTENTACTIVITYTYPE_T): 3 dropbox, 4 quiz, 5 forum,
       6 topic, anything else is content.
     GET /d2l/api/le/{le}/content/myItems/completions/due/?orgUnitIdsCSV=...&completedFromDateTime=...&completedToDateTime=...
     GET /d2l/api/le/{le}/content/myItems/completions/?orgUnitIdsCSV=...&completedFromDateTime=...&completedToDateTime=...
       The same items, filtered by completion date (note the different names).
     UTCDateTime is yyyy-MM-ddTHH:mm:ss.fffZ.

  4b. Calendar (res/calendar.html)
     GET /d2l/api/le/{le}/calendar/events/myEvents/?orgUnitIdsCSV=...&startDateTime=...&endDateTime=...
       orgUnitIdsCSV and both dates are required. ObjectListPage of EventDataInfo:
       { CalendarEventId, OrgUnitId, Title, StartDateTime, EndDateTime, IsAllDayEvent,
         StartDay, EndDay, IsRecurring, IsAssociatedWithEntity,
         AssociatedEntity: { AssociatedEntityType, AssociatedEntityId, Link },
         CalendarEventViewUrl, EventType }
       EventType (1.94+): 1 Reminder, 2 AvailabilityStarts, 3 AvailabilityEnds,
       4 UnlockStarts, 5 UnlockEnds, 6 DueDate. AssociatedEntityType ends in
       Dropbox, Quiz, DiscussionTopic or TopicCO, and AssociatedEntityId is that
       tool's own id, so these events merge with the tool rows. Start events only
       set opensAt. Events with no Learn item are kept when they are one-off and
       the title reads like a deadline (lab, report, quiz, midterm, due...).
     If the cross-course route fails, GET /d2l/api/le/{le}/{orgUnitId}/calendar/events/myEvents/
     is read per course instead.

  5. Dropbox folders and submission status (the most reliable "submitted")
     GET /d2l/api/le/{le}/{orgUnitId}/dropbox/folders/
       [{ Id, Name, DueDate, Availability: { StartDate, EndDate }, CategoryId, IsHidden }]
       A folder with no DueDate but an Availability.EndDate uses EndDate, and
       Availability.StartDate becomes opensAt. On UW many folders have neither.
     GET /d2l/api/le/{le}/{orgUnitId}/dropbox/folders/{folderId}/submissions/mysubmissions/
       A non-empty list means submitted. Both a flat list of submissions and a
       list of { Submissions: [] } entities are accepted (VERIFY which one UW returns).
     GET /d2l/api/le/{le}/{orgUnitId}/dropbox/categories/
       A category name containing "Lab" sets category "lab".

  6. Quizzes and discussions (for items the myItems feed misses)
     GET /d2l/api/le/{le}/{orgUnitId}/quizzes/          DueDate or EndDate (UW sets only EndDate), StartDate
     GET /d2l/api/le/{le}/{orgUnitId}/discussions/forums/
     GET /d2l/api/le/{le}/{orgUnitId}/discussions/forums/{forumId}/topics/
       DueDate, then UnlockEndDate, then the older EndDate. UnlockStartDate is opensAt.

  Items are keyed `${orgUnitId}:${kind}:${sourceId}`. The myItems feed and the
  course tools often describe the same item, so the tool id is read from
  ItemUrl (db=, qi=, topics/) when possible, and items with the same course,
  kind and title from different sources are merged as a second check. Rows
  with the same title and due minute are merged last (dropEchoes).
  Items may carry opensAt (ISO) when Learn gives a start date before the due date.

  Each item carries dueField ("due" when it came from DueDate, "end" when from
  an end date, "event" for a plain calendar event) and seenIn (the sources that
  listed it: dropbox, quizzes, discussions, feed, calendar). source.readOk maps
  each course id to the sources that read completely this time.

  Change detection lives in background.js (mergeLive): a 30 minute alarm reads
  everything again and compares each stored dueAt. A change of dueField alone
  is not a move. An item missing from a read is dropped only when every source
  in its seenIn read completely.

  Where the requests run
     1. The background service worker fetches with credentials: "include".
        host_permissions for learn.uwaterloo.ca should let Chrome attach the
        session cookie. VERIFY with UW's cookie settings.
     2. If the worker looks signed out, an open Learn tab's content script
        (learn-bridge.js) runs the same GET from the page's own origin.
     3. If neither works, checkSession gives a reason: signed-out (a Learn tab
        confirms it), no-tab (the worker looks signed out and no tab is open)
        or unreachable (no answer, timeout, Learn down). With a saved list the
        background keeps it and its reminders and shows a notice instead.
     Every request gives up after REQUEST_TIMEOUT_MS.
     Only GET requests are used, so no CSRF token is needed.

  One request at a time, spaced 150 ms apart.
  ------------------------------------------------------------------------
*/

export const LEARN_BASE = "https://learn.uwaterloo.ca";

const FALLBACK_VERSIONS = { lp: "1.30", le: "1.60" };
const GAP_MS = 150;
// A request that takes longer than this counts as Learn being unreachable.
export const REQUEST_TIMEOUT_MS = 20000;
const COLORS = ["pink", "green", "orange", "blue", "violet", "mint"];
const ACTIVITY_KIND = { 3: "dropbox", 4: "quiz", 5: "discussion", 6: "discussion" };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Learn origin LIVE mode reads. settings.liveBaseOverride exists only so the
 * local test mock can stand in for Learn, and only localhost addresses are accepted.
 */
export function liveBase(settings) {
  const o = settings && settings.liveBaseOverride;
  if (o) {
    try {
      const u = new URL(o);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
    } catch {
      /* ignore a bad override */
    }
  }
  return LEARN_BASE;
}

/* ------------------------------------------------------------------ */
/* Terms and course names                                              */
/* ------------------------------------------------------------------ */

/** UW term code: (year - 1900) * 10 + start month. Fall 2026 is 1269. */
export function termCodeFor(date) {
  const m = date.getMonth();
  const start = m < 4 ? 1 : m < 8 ? 5 : 9;
  return (date.getFullYear() - 1900) * 10 + start;
}

export function termRange(code) {
  const year = Math.floor(code / 10) + 1900;
  const month = code % 10;
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month + 3, 1);
  return { start, end };
}

const SEASON_MONTH = { winter: 1, spring: 5, summer: 5, fall: 9, autumn: 9 };

function termFromText(text) {
  const s = String(text || "");
  const code = s.match(/(?:^|[^0-9])(1\d\d[159])(?![0-9])/);
  if (code) return Number(code[1]);
  const words = s.match(/\b(winter|spring|summer|fall|autumn)\s*[_ ]?\s*(20\d\d)\b/i);
  if (words) return (Number(words[2]) - 1900) * 10 + SEASON_MONTH[words[1].toLowerCase()];
  return null;
}

const DASHES = "\\-:\\u2013\\u2014";
const COURSE_RE = new RegExp(
  `^\\s*([A-Z]{2,8})\\s*[_ ]?\\s*(\\d{3}[A-Z]{0,2})\\b((?:\\s*/\\s*[A-Z]{2,8}\\s*\\d{3}[A-Z]{0,2})*)\\s*[${DASHES}]?\\s*(.*)$`,
  "i"
);
const TERM_TAIL_RE = new RegExp(
  `\\s*(?:[${DASHES}]\\s*)?[([]?\\s*(?:winter|spring|summer|fall|autumn)\\s*[_ ]?\\s*20\\d\\d\\s*[)\\]]?\\s*$`,
  "i"
);
const SECTION_TAIL_RE = new RegExp(`\\s*(?:[${DASHES}]\\s*)?[([]?\\s*(?:(?:LEC|TUT|LAB|SEM)\\s*)?\\d{3}\\s*[)\\]]?\\s*$`, "i");

/**
 * "CS 341 - Algorithms" -> { code: "CS 341", name: "Algorithms" }.
 * Falls back to the org unit code for the course code, then to the raw name.
 */
export function parseCourseName(rawName, rawCode) {
  const raw = String(rawName || "").trim();
  const m = raw.match(COURSE_RE);
  if (m) {
    let name = (m[4] || "").replace(/^\s*(?:LEC|TUT|LAB|SEM)\s*\d{3}\b\s*/i, "");
    for (let i = 0; i < 3; i++) name = name.replace(TERM_TAIL_RE, "").replace(SECTION_TAIL_RE, "");
    name = name.replace(new RegExp(`^[${DASHES}\\s]+|[${DASHES}\\s]+$`, "g"), "");
    return { code: `${m[1].toUpperCase()} ${m[2].toUpperCase()}`, name };
  }
  const c = String(rawCode || "").match(/^\s*([A-Z]{2,8})\s*[_ -]?\s*(\d{3}[A-Z]{0,2})(?![0-9])/i);
  if (c) return { code: `${c[1].toUpperCase()} ${c[2].toUpperCase()}`, name: raw };
  // Not a course (co-op community, workshops): a short chip label, the full name as name.
  const full = raw || String(rawCode || "Course").replace(/_/g, " ").trim();
  return { code: shortLabel(full), name: full };
}

/** "Ideas Clinic EngSkills Workshops" -> "Ideas Clinic", so a chip stays about as wide as "ECE 298". */
function shortLabel(text, max = 18) {
  const words = String(text).split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || String(text).slice(0, max);
}

/** Sorts by course code and hands out colors in order, so the same course list always gets the same colors. */
export function assignColors(courses) {
  courses.sort((a, b) => a.code.localeCompare(b.code) || a.orgUnitId - b.orgUnitId);
  courses.forEach((c, i) => (c.color = COLORS[i % COLORS.length]));
  return courses;
}

/* ------------------------------------------------------------------ */
/* Report helpers                                                      */
/* ------------------------------------------------------------------ */

// Keys whose values are never copied into the debug report, at any depth.
/**
 * UW codes look like ECE203_pmitran_1269, so the middle segment is the
 * instructor's username. Debug reports get mailed to us, so keep the course
 * code and the term code and drop everything between them.
 */
function stripOwner(code) {
  const parts = String(code || "").split("_");
  const out = parts.length >= 3 ? `${parts[0]}_${parts[parts.length - 1]}` : parts.join("_");
  return out.slice(0, 60);
}

const PERSONAL = new Set([
  "FirstName", "LastName", "MiddleName", "UniqueName", "UserName", "Username", "DisplayName",
  "Email", "ExternalEmail", "OrgDefinedId", "Identifier", "ProfileIdentifier", "Pronouns",
  "UserId", "SubmittedBy", "Comment", "Feedback", "FileName", "Files", "Attachments",
  "CustomInstructions", "Instructions", "Description", "Header", "Footer", "Password", "NotificationEmail",
]);
// Keys whose real values are useful for checking the mapping and carry nothing personal.
const SHOW_VALUE = new Set([
  "ProductCode", "LatestVersion", "SupportedVersions", "ActivityType", "ItemType", "CompletionType", "DueDate", "EndDate",
  "StartDate", "SubmissionDate", "DateCompleted", "CompletionDate", "HasMoreItems", "IsActive",
  "CanAccess", "IsHidden", "IsExempt", "IsLocked", "ClasslistRoleName", "Code", "Name", "ItemName",
  "ItemUrl", "HomeUrl", "DropboxType", "SubmissionType", "StartDateAvailabilityType", "EndDateAvailabilityType",
  "UnlockStartDate", "UnlockEndDate", "PostStartDate", "PostEndDate", "EventType", "AssociatedEntityType",
  "IsAssociatedWithEntity", "IsRecurring", "IsAllDayEvent", "StartDateTime", "EndDateTime", "StartDay", "EndDay",
  "Title", "Link", "CalendarEventViewUrl",
]);

export function shapeOf(value, key = "", depth = 0) {
  if (PERSONAL.has(key)) return value == null ? null : "<redacted>";
  if (value === null || value === undefined) return value === null ? null : "<undefined>";
  if (Array.isArray(value)) {
    if (SHOW_VALUE.has(key) && value.every((v) => typeof v === "string")) return value.slice(0, 40);
    const out = value.slice(0, 2).map((v) => shapeOf(v, "", depth + 1));
    if (value.length > 2) out.push(`<${value.length - 2} more>`);
    return out;
  }
  if (typeof value === "object") {
    if (depth > 6) return "<object>";
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shapeOf(v, k, depth + 1);
    return out;
  }
  if (SHOW_VALUE.has(key)) return typeof value === "string" ? value.slice(0, 160) : value;
  if (typeof value === "string") return `<string ${value.length}>`;
  if (typeof value === "number") return "<number>";
  return value;
}

const ERROR_BODY_READ = 2000;
const ERROR_BODY_KEEP = 400;

/**
 * Error bodies go into the debug report, so anything that could name the
 * student is removed first: email addresses, 8+ digit numbers (student
 * numbers), and the names whoami returned.
 */
export function redactText(text, personal = []) {
  let s = String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\b\d{8,}\b/g, "<number>");
  for (const p of personal) {
    if (p && p.length > 1) s = s.split(p).join("<redacted>");
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > ERROR_BODY_KEEP ? `${s.slice(0, ERROR_BODY_KEEP)}...` : s;
}

/** The query string as the report shows it: org unit lists become a count, bookmarks are shortened. */
export function queryForReport(path) {
  const i = path.indexOf("?");
  if (i < 0) return null;
  const out = {};
  for (const [k, v] of new URLSearchParams(path.slice(i + 1))) {
    if (/orgunitids/i.test(k)) out[k] = `<${v.split(",").filter(Boolean).length} ids>`;
    else if (k === "bookmark") out[k] = v.length > 24 ? `${v.slice(0, 24)}...` : v;
    else out[k] = v.slice(0, 40);
  }
  return out;
}

function endpointName(path) {
  return path
    .split("?")[0]
    .replace(/\/d2l\/api\/(lp|le)\/[\d.]+\//, "/d2l/api/$1/{v}/")
    .replace(/\/\d+(?=\/)/g, "/{id}");
}

/* ------------------------------------------------------------------ */
/* Item helpers                                                        */
/* ------------------------------------------------------------------ */

const listOf = (x) => (Array.isArray(x) ? x : x && Array.isArray(x.Objects) ? x.Objects : x && Array.isArray(x.Items) ? x.Items : []);

function isoOrNull(v) {
  if (!v || typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function kindOf(x) {
  const a = x.ActivityType;
  if (typeof a === "number" && ACTIVITY_KIND[a]) return ACTIVITY_KIND[a];
  const s = `${typeof a === "string" ? a : ""} ${x.ItemUrl || ""}`.toLowerCase();
  if (s.includes("dropbox") || s.includes("assignment")) return "dropbox";
  if (s.includes("quiz")) return "quiz";
  if (s.includes("discussion")) return "discussion";
  return "content";
}

function toolIdFromUrl(kind, url) {
  const u = String(url || "");
  let m = null;
  if (kind === "dropbox") m = u.match(/[?&]db=(\d+)/) || u.match(/\/folders?\/(\d+)/i);
  if (kind === "quiz") m = u.match(/[?&]qi=(\d+)/) || u.match(/\/quizzes\/(\d+)/i);
  if (kind === "discussion") m = u.match(/\/topics\/(\d+)/i) || u.match(/[?&]topicId=(\d+)/i);
  return m ? m[1] : null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function categoryFor(kind, title, categoryName) {
  if (kind === "dropbox") return /\blab/i.test(categoryName || "") || /^\s*lab\b/i.test(title || "") ? "lab" : "assignment";
  if (kind === "quiz" || kind === "discussion") return kind;
  return "content";
}

/** Learn wants yyyy-MM-ddTHH:mm:ss.fffZ, which is what toISOString gives. */
const utcDateTime = (d) => new Date(d).toISOString();

/** An opens date only matters when it is before the due date. */
const laterOnly = (opens, due) => (opens && due && opens < due ? opens : null);

/** Which Learn field a due date came from: "due" for DueDate, "end" for an end date. */
const fieldOf = (dueValue) => (isoOrNull(dueValue) ? "due" : "end");

/** Per tool counts for the report: how many rows came back, how many were hidden or had no date, with a few undated examples. */
function seenCounter(rep, tool, total) {
  const stats = { total, hidden: 0, dated: 0, undated: 0, undatedSamples: [] };
  if (rep) {
    rep.seen = rep.seen || {};
    rep.seen[tool] = stats;
  }
  return {
    stats,
    sample(name, dates, dated) {
      if (dated) stats.dated++;
      else {
        stats.undated++;
        if (stats.undatedSamples.length < 3) stats.undatedSamples.push({ name: String(name || "").slice(0, 60), ...dates });
      }
    },
  };
}

// Calendar AssociatedEntityType (last part) -> item kind. null means skip the event.
const ENTITY_KIND = {
  Dropbox: "dropbox",
  Quiz: "quiz",
  DiscussionTopic: "discussion",
  TopicCO: "content",
  ModuleCO: null,
  DiscussionForum: null,
  GradeObject: null,
};
// Calendar EventType (LE API 1.94+): 1 Reminder, 2 AvailabilityStarts, 3 AvailabilityEnds, 4 UnlockStarts, 5 UnlockEnds, 6 DueDate.
const EVENT_TYPE = { 1: "reminder", 2: "opens", 3: "ends", 4: "opens", 5: "ends", 6: "due" };
const RANK = { due: 3, ends: 2, event: 1, reminder: 0 };
const EVENT_SUFFIX_RE = /\s*[-:–—]\s*(?:due(?: date)?|availability (?:ends|starts)|available|ends|starts|end date|start date|unlocks?|unlock (?:ends|starts))\s*$/i;
const DEADLINE_WORDS = /\b(?:due|deadline|submi\w*|assignment|assgn|lab|report|quiz|test|midterm|exam|final|project|problem sets?|homework|hw\s?\d*|psets?|deliverable|presentation|proposal|essay|reflection|milestone|checkpoint|a\d{1,2})\b/i;

function eventTypeOf(ev) {
  if (EVENT_TYPE[ev.EventType]) return EVENT_TYPE[ev.EventType];
  const t = String(ev.Title || "");
  const m = t.match(EVENT_SUFFIX_RE);
  if (m) {
    const w = m[0].toLowerCase();
    if (w.includes("due")) return "due";
    if (/ends|end date/.test(w)) return "ends";
    return "opens";
  }
  return "event";
}

/** The moment an event stands for. All-day events count as 11:59 pm on their day. */
function eventDate(ev) {
  const assoc = !!(ev.AssociatedEntity && ev.IsAssociatedWithEntity !== false);
  if (ev.IsAllDayEvent) {
    const day = String(ev.EndDay || ev.StartDay || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59).toISOString();
  }
  // A Learn item's event marks its date at the end; a plain event (a midterm) matters when it starts.
  return assoc ? isoOrNull(ev.EndDateTime) || isoOrNull(ev.StartDateTime) : isoOrNull(ev.StartDateTime) || isoOrNull(ev.EndDateTime);
}

/** "Lab 2 Report - Due" -> "Lab 2 Report". */
export function cleanEventTitle(title) {
  return String(title || "").replace(EVENT_SUFFIX_RE, "").trim();
}

function categoryFromTitle(title) {
  const t = String(title || "");
  if (/\blab\b/i.test(t)) return "lab";
  if (/\b(?:quiz|test|midterm|exam)\b/i.test(t)) return "quiz";
  if (/\b(?:assignment|a\d{1,2}|homework|hw|problem sets?|psets?|report|project|deliverable|proposal|essay)\b/i.test(t)) return "assignment";
  return "content";
}

/**
 * The same deadline can reach us twice under different ids, for example a
 * content topic event and the dropbox folder it links to. Rows with the same
 * title and due minute are merged, keeping the tool row, unless both came
 * from a tool.
 */
function dropEchoes(items) {
  const score = (i) => (i.srcs.has("tool") ? 4 : 0) + (i.kind !== "content" ? 2 : 0) + (i.srcs.has("feed") ? 1 : 0);
  const out = [];
  const seen = new Map();
  for (const i of [...items].sort((a, b) => score(b) - score(a))) {
    const k = `${norm(cleanEventTitle(i.title))}|${Math.round(Date.parse(i.dueAt) / 60000)}`;
    const keep = seen.get(k);
    if (keep && !(keep.srcs.has("tool") && i.srcs.has("tool"))) {
      if (i.status === "submitted" && keep.status !== "submitted") {
        keep.status = "submitted";
        keep.completedAt = i.completedAt;
      }
      if (!keep.opensAt && i.opensAt) keep.opensAt = i.opensAt;
      for (const x of i.seen || []) keep.seen && keep.seen.add(x);
      continue;
    }
    if (!keep) seen.set(k, i);
    out.push(i);
  }
  return out;
}

export function itemUrl(base, ou, kind, id) {
  switch (kind) {
    case "dropbox":
      return `${base}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${id}&ou=${ou}`;
    case "quiz":
      return `${base}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${id}&ou=${ou}`;
    case "discussion":
      return `${base}/d2l/le/${ou}/discussions/topics/${id}/View`;
    default:
      return `${base}/d2l/le/content/${ou}/viewContent/${id}/View`;
  }
}

function absolute(base, url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function signedOutError() {
  const err = new Error("Learn says nobody is signed in.");
  err.code = "signed-out";
  return err;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SIGNED_OUT_WHY = new Set(["signed-out", "forbidden", "not-json", "odd-whoami"]);

/**
 * Why a session check failed, from what the worker and the Learn tab each got.
 *   signed-out   an open Learn tab says nobody is signed in, so the login really expired
 *   unreachable  no answer from Learn (no network, timeout, Learn down)
 *   no-tab       the worker looks signed out and there is no Learn tab to ask. The
 *                worker may simply not get the cookie, so this is not proof of a
 *                signed-out student.
 */
export function sessionReason(workerWhy, tabWhy) {
  if (SIGNED_OUT_WHY.has(tabWhy)) return "signed-out";
  if (tabWhy !== "no-tab") return "unreachable";
  if (SIGNED_OUT_WHY.has(workerWhy)) return "no-tab";
  return "unreachable";
}

/* ------------------------------------------------------------------ */
/* Source                                                            */
/* ------------------------------------------------------------------ */

export class LiveSource {
  /**
   * @param {object} settings
   * @param {{relay?: (base: string, path: string) => Promise<object>, now?: Date}} [opts]
   *   relay runs a GET through an open Learn tab. It resolves to the same result
   *   object as workerFetch, or { noTab: true } when there is no usable tab.
   */
  constructor(settings, opts = {}) {
    this.mode = "live";
    this.base = liveBase(settings);
    this.settings = settings;
    this.relay = opts.relay || null;
    this.now = opts.now || new Date();
    this.versions = null;
    this.via = "worker";
    this.lastAt = 0;
    this.feed = null;
    this.fullShapes = new Set();
    this.personal = [];
    this.calendar = null;
    // Course id -> the sources that read completely for it this time
    // (dropbox, quizzes, discussions, feed, calendar). An item that disappeared
    // is only dropped when every source it came from read completely.
    this.readOk = new Map();
    this.report = {
      kind: "watnow-live-debug",
      startedAt: this.now.toISOString(),
      base: this.base,
      via: null,
      session: null,
      versions: null,
      term: null,
      requests: [],
      shapes: {},
      courses: [],
      counts: null,
      notes: [],
    };
  }

  async workerFetch(path) {
    let res;
    try {
      res = await fetch(this.base + path, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { status: 0, error: e && e.name === "TimeoutError" ? "timeout" : String(e && e.message ? e.message : e) };
    }
    const type = res.headers.get("content-type") || "";
    const loginRedirect = /\/d2l\/login/i.test(res.url || "");
    let json;
    let parseError = null;
    let body;
    if (res.ok && type.includes("json")) {
      try {
        json = await res.json();
      } catch (e) {
        parseError = String(e && e.message ? e.message : e);
      }
    } else if (!res.ok && !loginRedirect) {
      // Learn explains a 400 in the body. Only the start is kept, for the debug report.
      try {
        body = (await res.text()).slice(0, ERROR_BODY_READ);
      } catch {
        /* no body */
      }
    }
    return { status: res.status, redirected: res.redirected, loginRedirect, type, json, parseError, body };
  }

  async fetchVia(path, via) {
    const gap = GAP_MS - (Date.now() - this.lastAt);
    if (gap > 0) await wait(gap);
    this.lastAt = Date.now();
    if (via === "tab") {
      if (!this.relay) return { noTab: true };
      try {
        let timer;
        const late = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: 0, error: "timeout" }), REQUEST_TIMEOUT_MS + 2000);
        });
        try {
          return await Promise.race([this.relay(this.base, path), late]);
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        return { status: 0, error: String(e && e.message ? e.message : e) };
      }
    }
    return this.workerFetch(path);
  }

  /**
   * One GET. Returns parsed JSON or throws an Error with code:
   * signed-out, forbidden, not-found, not-json, http, network.
   */
  async api(path, { via = this.via } = {}) {
    const t0 = Date.now();
    const r = await this.fetchVia(path, via);
    const entry = { endpoint: endpointName(path), path: path.split("?")[0], via, status: r.status ?? null, ms: Date.now() - t0 };
    const query = queryForReport(path);
    if (query) entry.query = query;
    this.report.requests.push(entry);
    let code = null;
    if (r.noTab) code = "no-tab";
    else if (r.loginRedirect || r.status === 401) code = "signed-out";
    else if (r.status === 0) code = "network";
    else if (r.status === 403) code = "forbidden";
    else if (r.status === 404) code = "not-found";
    else if (r.status < 200 || r.status >= 300) code = "http";
    else if (r.json === undefined) code = "not-json";
    if (code) {
      entry.error = code;
      if (r.type && code === "not-json") entry.contentType = r.type.slice(0, 60);
      if (r.error) entry.detail = String(r.error).slice(0, 160);
      if (typeof r.body === "string" && r.body.trim()) entry.body = redactText(r.body, this.personal);
      const err = new Error(code === "signed-out" ? "Learn says nobody is signed in." : `Learn returned ${r.status || "no response"} for ${entry.endpoint}`);
      err.code = code;
      err.status = r.status;
      throw err;
    }
    const j = r.json;
    if (Array.isArray(j) || (j && (Array.isArray(j.Objects) || Array.isArray(j.Items)))) entry.count = listOf(j).length;
    // Keep replacing an empty sample until a response with something in it comes back.
    if (!this.fullShapes.has(entry.endpoint)) {
      this.report.shapes[entry.endpoint] = shapeOf(j);
      if (entry.count !== 0) this.fullShapes.add(entry.endpoint);
    }
    return r.json;
  }

  async paged(path) {
    const out = [];
    let next = path;
    for (let i = 0; i < 25 && next; i++) {
      const page = await this.api(next);
      out.push(...listOf(page));
      const info = page && page.PagingInfo;
      if (info && info.HasMoreItems && info.Bookmark) {
        const sep = path.includes("?") ? "&" : "?";
        next = `${path}${sep}bookmark=${encodeURIComponent(info.Bookmark)}`;
      } else if (page && typeof page.Next === "string" && page.Next) {
        try {
          const u = new URL(page.Next, this.base);
          next = u.pathname + u.search;
        } catch {
          next = null;
        }
      } else next = null;
    }
    return out;
  }

  async ensureVersions(via = this.via) {
    if (this.versions) return this.versions;
    const v = { ...FALLBACK_VERSIONS };
    try {
      const list = await this.api("/d2l/api/versions/", { via });
      for (const p of Array.isArray(list) ? list : []) {
        const code = String(p.ProductCode || "").toLowerCase();
        if ((code === "lp" || code === "le") && typeof p.LatestVersion === "string") v[code] = p.LatestVersion;
      }
    } catch (e) {
      // Not cached, so the next call tries again (possibly through a Learn tab).
      this.report.notes.push(`versions via ${via} failed (${e.code}), using ${v.lp}/${v.le} for now`);
      return v;
    }
    this.versions = v;
    this.report.versions = v;
    return v;
  }

  async whoami(via) {
    const { lp } = await this.ensureVersions(via);
    try {
      const me = await this.api(`/d2l/api/lp/${lp}/users/whoami`, { via });
      if (!me || typeof me !== "object" || (!me.Identifier && !me.UniqueName && !me.FirstName)) return { signedIn: false, why: "odd-whoami" };
      const first = String(me.FirstName || "").trim();
      const last = String(me.LastName || "").trim();
      const initials = `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
      this.personal = [`${first} ${last}`, first, last, String(me.UniqueName || ""), String(me.Identifier || "")]
        .filter((x) => x.trim().length > 1)
        .sort((a, b) => b.length - a.length);
      return { signedIn: true, student: { name: `${first} ${last}`.trim(), initials } };
    } catch (e) {
      if (["signed-out", "forbidden", "not-json", "no-tab"].includes(e.code)) return { signedIn: false, why: e.code };
      return { signedIn: false, why: e.code || "error", error: e };
    }
  }

  async checkSession() {
    const worker = await this.whoami("worker");
    const session = { worker: worker.signedIn ? "signed-in" : worker.why };
    this.report.session = session;
    if (worker.signedIn) {
      this.via = "worker";
      this.report.via = "worker";
      return { signedIn: true, student: worker.student, via: "worker" };
    }
    let tab = { why: "no-tab" };
    if (this.relay) {
      tab = await this.whoami("tab");
      session.tab = tab.signedIn ? "signed-in" : tab.why;
      if (tab.signedIn) {
        this.via = "tab";
        this.report.via = "tab";
        return { signedIn: true, student: tab.student, via: "tab" };
      }
    }
    return { signedIn: false, reason: sessionReason(worker.why, tab.why) };
  }

  async listCourses() {
    const { lp } = await this.ensureVersions();
    const rows = await this.paged(`/d2l/api/lp/${lp}/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true`);
    const current = termCodeFor(this.now);
    const now = this.now.getTime();
    const candidates = [];
    for (const row of rows) {
      const ou = row && row.OrgUnit;
      const id = ou && Number(ou.Id);
      if (!id) continue;
      const access = row.Access || {};
      if (access.CanAccess === false || access.IsActive === false) continue;
      const typeId = ou.Type && ou.Type.Id;
      if (typeId != null && Number(typeId) !== 3) continue;
      const term = termFromText(ou.Code) || termFromText(ou.Name);
      const start = Date.parse(access.StartDate || "");
      const end = Date.parse(access.EndDate || "");
      let inDates = null;
      if (!Number.isNaN(start) || !Number.isNaN(end)) {
        inDates = (Number.isNaN(start) || start - 14 * DAY_MS <= now) && (Number.isNaN(end) || end + 14 * DAY_MS >= now);
      }
      candidates.push({ row, id, term, inDates });
    }
    // A course with a term in its name or code is kept only for the current term.
    // A unit with no term clue (co-op community, certificates, workshops) is read
    // too, but stays in the list only if it has something coming up (see
    // keepTermless). Access dates that clearly ended drop it early.
    const matched = candidates.filter((c) => c.term === current);
    const termless = candidates.filter((c) => c.term == null && c.inDates !== false);
    let kept = [...matched, ...termless];
    let termFilter = "term";
    if (!matched.length && termless.length) {
      termFilter = "no course matched the term, kept units with no term";
    } else if (!matched.length && candidates.length) {
      kept = candidates;
      termFilter = "no course matched the term, kept all active";
    }
    this.report.term = {
      current,
      filter: termFilter,
      enrolled: rows.length,
      candidates: candidates.length,
      termMatched: matched.length,
      otherTerm: candidates.filter((c) => c.term != null && c.term !== current).length,
      noTermClue: termless.length,
      read: kept.length,
    };

    const courses = kept.map(({ row, id, term }) => {
      const { code, name } = parseCourseName(row.OrgUnit.Name, row.OrgUnit.Code);
      return {
        id: `ou${id}`,
        code,
        name,
        orgUnitId: id,
        color: "mint",
        termMatch: term === current,
        // current: shown as a course while scanning and kept even with nothing due.
        current: term === current || termFilter !== "term",
        homeUrl: absolute(this.base, row.OrgUnit.HomeUrl) || `${this.base}/d2l/home/${id}`,
      };
    });
    assignColors(courses);
    for (const c of courses) {
      const row = kept.find((k) => k.id === c.orgUnitId).row;
      this.report.courses.push({
        orgUnitId: c.orgUnitId,
        rawName: String(row.OrgUnit.Name || "").slice(0, 120),
        rawCode: stripOwner(row.OrgUnit.Code),
        code: c.code,
        name: c.name,
        termMatch: c.termMatch,
        current: c.current,
        tools: {},
      });
    }
    this.courseIds = new Set(courses.map((c) => c.orgUnitId));
    this.currentIds = new Set(courses.filter((c) => c.current).map((c) => c.orgUnitId));
    this.courseOrder = [...courses.filter((c) => c.current), ...courses.filter((c) => !c.current)].map((c) => c.orgUnitId);
    return courses;
  }

  /** Org unit ids for the cross-course routes, current courses first, at most 100 per request. */
  idChunks() {
    const ids = [...(this.courseOrder || this.courseIds || [])];
    const out = [];
    for (let i = 0; i < ids.length; i += 100) out.push(ids.slice(i, i + 100));
    return out;
  }

  /** The window the feed and the calendar are read for: two weeks before the term (or a month back) to three weeks after it. */
  window() {
    const { start, end } = termRange(termCodeFor(this.now));
    const from = new Date(Math.min(start.getTime(), this.now.getTime() - 30 * DAY_MS) - 14 * DAY_MS);
    const to = new Date(end.getTime() + 21 * DAY_MS);
    return { from: utcDateTime(from), to: utcDateTime(to) };
  }

  /**
   * Reads one cross-course route for every chunk of org unit ids. Learn answers
   * 400 without orgUnitIdsCSV. If a chunk that mixes current courses and other
   * units gets a 400, it is tried once more with the current courses only.
   */
  async readAcross(name, route, params, failed) {
    const rows = [];
    let ok = 0;
    // Org unit ids this route could not read.
    const missed = new Set();
    for (const chunk of this.idChunks()) {
      const tryRead = async (ids) => {
        const q = new URLSearchParams({ orgUnitIdsCSV: ids.join(","), ...params });
        return this.paged(`${route}?${q.toString().replace(/%2C/gi, ",")}`);
      };
      try {
        rows.push(...(await tryRead(chunk)));
        ok++;
      } catch (e) {
        if (e.code === "signed-out") throw e;
        const narrower = chunk.filter((id) => this.currentIds && this.currentIds.has(id));
        if (e.status === 400 && narrower.length && narrower.length < chunk.length) {
          try {
            rows.push(...(await tryRead(narrower)));
            ok++;
            failed.push(`${name}: 400 with all units, worked with current courses only`);
            for (const id of chunk) if (!narrower.includes(id)) missed.add(id);
            continue;
          } catch (e2) {
            if (e2.code === "signed-out") throw e2;
          }
        }
        failed.push(`${name}: ${e.code}${e.status ? ` ${e.status}` : ""}`);
        for (const id of chunk) missed.add(id);
      }
    }
    return { rows, ok: ok > 0, missed };
  }

  /** The cross-course myItems feed (content topics and anything else with dates), read once per sync. */
  async ensureFeed() {
    if (this.feed) return this.feed;
    const { le } = await this.ensureVersions();
    const { from, to } = this.window();
    const doneTo = utcDateTime(new Date(this.now.getTime() + DAY_MS));
    const feed = { items: [], completed: new Map(), failed: [], ok: 0, missed: new Set(), activityTypes: {} };
    const range = { startDateTime: from, endDateTime: to };
    // The completions routes filter on the completion date and take different names.
    const doneRange = { completedFromDateTime: from, completedToDateTime: doneTo };
    const reads = [
      ["myItems/due", `/d2l/api/le/${le}/content/myItems/due/`, range],
      ["myItems", `/d2l/api/le/${le}/content/myItems/`, range],
      ["completions/due", `/d2l/api/le/${le}/content/myItems/completions/due/`, doneRange],
      ["completions", `/d2l/api/le/${le}/content/myItems/completions/`, doneRange],
    ];
    const got = {};
    for (const [name, route, params] of reads) {
      const r = await this.readAcross(name, route, params, feed.failed);
      if (r.ok) feed.ok++;
      for (const id of r.missed) feed.missed.add(id);
      got[name] = r.rows;
    }
    for (const x of [...got["completions/due"], ...got.completions]) {
      if (!x || x.OrgUnitId == null || x.ItemId == null) continue;
      const at = isoOrNull(x.DateCompleted) || isoOrNull(x.CompletionDate) || isoOrNull(x.CompletedDate) || this.now.toISOString();
      feed.completed.set(`${x.OrgUnitId}:${x.ItemId}`, at);
    }
    for (const x of [...got["myItems/due"], ...got.myItems]) {
      if (!x || x.OrgUnitId == null || x.ItemId == null) continue;
      feed.activityTypes[String(x.ActivityType)] = (feed.activityTypes[String(x.ActivityType)] || 0) + 1;
      feed.items.push(x);
    }
    this.report.feed = {
      ok: feed.ok,
      failed: feed.failed,
      items: feed.items.length,
      completions: feed.completed.size,
      activityTypes: feed.activityTypes,
      range: { from, to },
      orgUnits: (this.courseOrder || []).length,
    };
    this.feed = feed;
    return feed;
  }

  /** Calendar events for every course, read once per sync. Falls back to one request per course if the cross-course route fails. */
  async ensureCalendar() {
    if (this.calendar) return this.calendar;
    const { le } = await this.ensureVersions();
    const { from, to } = this.window();
    const cal = { events: [], ok: false, perCourse: false, failed: [], missed: new Set() };
    const r = await this.readAcross("calendar", `/d2l/api/le/${le}/calendar/events/myEvents/`, { startDateTime: from, endDateTime: to }, cal.failed);
    cal.events = r.rows;
    cal.ok = r.ok;
    cal.missed = r.missed;
    if (!r.ok) cal.perCourse = true;
    this.report.calendar = { ok: cal.ok, perCourse: cal.perCourse, failed: cal.failed, events: cal.events.length, range: { from, to }, eventTypes: {}, used: 0, skipped: [] };
    this.calendar = cal;
    return cal;
  }

  async calendarFor(course, le) {
    const cal = await this.ensureCalendar();
    const ou = course.orgUnitId;
    // The cross-course read covered this course: use it. Otherwise ask the course itself.
    if (!cal.perCourse && !cal.missed.has(ou)) return { ok: true, events: cal.events.filter((e) => e && Number(e.OrgUnitId) === ou) };
    const { from, to } = this.window();
    const q = new URLSearchParams({ startDateTime: from, endDateTime: to });
    try {
      return { ok: true, events: await this.paged(`/d2l/api/le/${le}/${ou}/calendar/events/myEvents/?${q}`) };
    } catch (e) {
      if (e.code === "signed-out") throw e;
      return { ok: false, error: e };
    }
  }

  /** Turns calendar events into deadline rows. Start events only set opensAt on the matching row. */
  calendarRows(events, rep) {
    const calRep = this.report.calendar;
    const byEntity = new Map();
    const opens = new Map();
    const rows = [];
    let skipped = 0;
    for (const ev of events) {
      if (!ev || ev.CalendarEventId == null) continue;
      const type = eventTypeOf(ev);
      if (calRep) calRep.eventTypes[type] = (calRep.eventTypes[type] || 0) + 1;
      const assoc = ev.IsAssociatedWithEntity !== false && ev.AssociatedEntity && ev.AssociatedEntity.AssociatedEntityId != null ? ev.AssociatedEntity : null;
      const entity = assoc ? ENTITY_KIND[String(assoc.AssociatedEntityType || "").split(".").pop()] : null;
      const at = eventDate(ev);
      const title = cleanEventTitle(ev.Title);
      if (!at || !title) continue;
      const url = absolute(this.base, (assoc && assoc.Link) || ev.CalendarEventViewUrl);
      if (type === "reminder") continue;
      if (type === "opens") {
        if (entity) opens.set(`${entity}:${assoc.AssociatedEntityId}`, at);
        continue;
      }
      if (assoc) {
        if (entity === null || (entity === undefined && type !== "due" && type !== "ends")) {
          skipped++;
          continue;
        }
        const kind = entity || "content";
        const sourceId = entity ? String(assoc.AssociatedEntityId) : `cal${ev.CalendarEventId}`;
        const key = `${kind}:${sourceId}`;
        const prev = byEntity.get(key);
        // A due date beats an end date for the same item.
        if (prev && (prev.rank > RANK[type] || (prev.rank === RANK[type] && prev.dueAt >= at))) continue;
        const row = { kind, sourceId, title, dueAt: at, dueField: type === "due" ? "due" : type === "ends" ? "end" : "event", url, completedAt: null, rank: RANK[type] ?? 0 };
        if (prev) rows[rows.indexOf(prev)] = row;
        else rows.push(row);
        byEntity.set(key, row);
        continue;
      }
      // An event with no Learn item behind it: kept when it is a one-off with a deadline-like title.
      if (ev.IsRecurring === true || !DEADLINE_WORDS.test(title)) {
        skipped++;
        if (calRep && calRep.skipped.length < 12) calRep.skipped.push(String(title).slice(0, 60));
        continue;
      }
      rows.push({ kind: "content", sourceId: `cal${ev.CalendarEventId}`, title, dueAt: at, dueField: "event", url, completedAt: null, category: categoryFromTitle(title) });
    }
    for (const row of rows) {
      const o = opens.get(`${row.kind}:${row.sourceId}`);
      if (o && o < row.dueAt) row.opensAt = o;
    }
    if (calRep) calRep.used += rows.length;
    if (rep) rep.calendarSkipped = skipped;
    return { rows, opens };
  }

  async readDropbox(course, le, rep) {
    const ou = course.orgUnitId;
    const folders = listOf(await this.api(`/d2l/api/le/${le}/${ou}/dropbox/folders/`));
    const catNames = {};
    if (folders.some((f) => f && f.CategoryId)) {
      try {
        for (const c of listOf(await this.api(`/d2l/api/le/${le}/${ou}/dropbox/categories/`))) {
          if (c && c.Id != null) catNames[c.Id] = c.Name;
        }
      } catch (e) {
        if (e.code === "signed-out") throw e;
      }
    }
    const seen = seenCounter(rep, "dropbox", folders.length);
    const out = [];
    for (const f of folders) {
      if (!f || f.Id == null) continue;
      if (f.IsHidden === true) {
        seen.stats.hidden++;
        continue;
      }
      const avail = f.Availability || {};
      // UW folders often leave DueDate empty and close the folder with Availability.EndDate.
      const dueAt = isoOrNull(f.DueDate) || isoOrNull(avail.EndDate);
      seen.sample(f.Name, { DueDate: f.DueDate ?? null, StartDate: avail.StartDate ?? null, EndDate: avail.EndDate ?? null }, !!dueAt);
      if (!dueAt) continue;
      let submittedAt = null;
      try {
        const subs = listOf(await this.api(`/d2l/api/le/${le}/${ou}/dropbox/folders/${f.Id}/submissions/mysubmissions/`));
        const dates = [];
        for (const s of subs) {
          const inner = s && Array.isArray(s.Submissions) ? s.Submissions : [s];
          for (const x of inner) {
            if (!x) continue;
            dates.push(isoOrNull(x.SubmissionDate) || this.now.toISOString());
          }
        }
        if (dates.length) submittedAt = dates.sort().pop();
      } catch (e) {
        if (e.code === "signed-out") throw e;
      }
      out.push({
        kind: "dropbox",
        sourceId: String(f.Id),
        title: String(f.Name || "Dropbox folder"),
        dueAt,
        dueField: fieldOf(f.DueDate),
        opensAt: laterOnly(isoOrNull(avail.StartDate), dueAt),
        categoryName: catNames[f.CategoryId] || "",
        completedAt: submittedAt,
      });
    }
    return out;
  }

  async readQuizzes(course, le, rep) {
    const ou = course.orgUnitId;
    const quizzes = await this.paged(`/d2l/api/le/${le}/${ou}/quizzes/`);
    const seen = seenCounter(rep, "quizzes", quizzes.length);
    const out = [];
    for (const q of quizzes) {
      const id = q && (q.QuizId ?? q.Id);
      if (id == null) continue;
      if (q.IsActive === false) {
        seen.stats.hidden++;
        continue;
      }
      const dueAt = isoOrNull(q.DueDate) || isoOrNull(q.EndDate);
      seen.sample(q.Name, { DueDate: q.DueDate ?? null, StartDate: q.StartDate ?? null, EndDate: q.EndDate ?? null }, !!dueAt);
      if (!dueAt) continue;
      out.push({ kind: "quiz", sourceId: String(id), title: String(q.Name || "Quiz"), dueAt, dueField: fieldOf(q.DueDate), opensAt: laterOnly(isoOrNull(q.StartDate), dueAt), completedAt: null });
    }
    return out;
  }

  async readDiscussions(course, le, rep) {
    const ou = course.orgUnitId;
    const forums = listOf(await this.api(`/d2l/api/le/${le}/${ou}/discussions/forums/`));
    const out = [];
    let failures = 0;
    let total = 0;
    const topicsSeen = [];
    for (const f of forums) {
      if (!f || f.ForumId == null || f.IsHidden === true) continue;
      try {
        const topics = listOf(await this.api(`/d2l/api/le/${le}/${ou}/discussions/forums/${f.ForumId}/topics/`));
        total += topics.length;
        topicsSeen.push(...topics);
      } catch (e) {
        if (e.code === "signed-out") throw e;
        failures++;
      }
    }
    const seen = seenCounter(rep, "discussions", total);
    for (const t of topicsSeen) {
      if (!t || t.TopicId == null) continue;
      if (t.IsHidden === true) {
        seen.stats.hidden++;
        continue;
      }
      // Newer Learn versions use DueDate plus UnlockStartDate/UnlockEndDate; older ones StartDate/EndDate.
      const dueAt = isoOrNull(t.DueDate) || isoOrNull(t.UnlockEndDate) || isoOrNull(t.EndDate) || isoOrNull(t.PostEndDate);
      seen.sample(t.Name, { DueDate: t.DueDate ?? null, UnlockEndDate: t.UnlockEndDate ?? null, EndDate: t.EndDate ?? null }, !!dueAt);
      if (!dueAt) continue;
      const opensAt = laterOnly(isoOrNull(t.UnlockStartDate) || isoOrNull(t.StartDate), dueAt);
      out.push({ kind: "discussion", sourceId: String(t.TopicId), title: String(t.Name || "Discussion"), dueAt, dueField: fieldOf(t.DueDate), opensAt, completedAt: null });
    }
    if (failures && !out.length && failures === forums.length) {
      const err = new Error("Every discussion forum failed");
      err.code = "forums";
      throw err;
    }
    if (failures) rep.discussionsPartial = failures;
    return out;
  }

  /** All dated items for one course. One failing tool leaves the others in place. */
  async listDeadlines(course) {
    const { le } = await this.ensureVersions();
    const ou = course.orgUnitId;
    const rep = this.report.courses.find((c) => c.orgUnitId === ou) || { tools: {} };
    const byKey = new Map();
    const byTitle = new Map();

    // Tool rows are exact, so their dates win. The feed's ItemUrl wins for links.
    // A row is matched by its tool id first, then by kind and title against a row
    // from a different source (two folders can share a name).
    const add = (x, src) => {
      const key = `${ou}:${x.kind}:${x.sourceId}`;
      const tkey = `${x.kind}:${norm(x.title)}`;
      let found = byKey.get(key);
      if (!found) {
        const t = byTitle.get(tkey);
        if (t && !t.srcs.has(src)) found = t;
      }
      if (!found) {
        const item = {
          id: key,
          courseId: course.id,
          kind: x.kind,
          category: x.category || categoryFor(x.kind, x.title, x.categoryName),
          title: x.title,
          dueAt: x.dueAt,
          dueField: x.dueField || null,
          url: x.url || itemUrl(this.base, ou, x.kind, x.sourceId),
          status: x.completedAt ? "submitted" : "open",
          completedAt: x.completedAt || null,
          moved: null,
          srcs: new Set([src]),
          seen: new Set([source]),
        };
        if (x.opensAt) item.opensAt = x.opensAt;
        byKey.set(key, item);
        if (!byTitle.has(tkey)) byTitle.set(tkey, item);
        return;
      }
      if (src === "tool" && !found.srcs.has("tool")) {
        found.dueAt = x.dueAt;
        found.dueField = x.dueField || null;
        found.category = categoryFor(x.kind, x.title, x.categoryName);
        found.title = x.title;
      } else if (src === "feed" && x.url) found.url = x.url;
      if (x.opensAt && (!found.opensAt || src === "tool")) found.opensAt = x.opensAt;
      if (x.completedAt && found.status !== "submitted") {
        found.status = "submitted";
        found.completedAt = x.completedAt;
      }
      found.srcs.add(src);
      found.seen.add(source);
      byKey.set(key, found);
    };

    let okCount = 0;
    let failCount = 0;
    const sourcesOk = [];
    let source = "";
    const tools = [
      ["dropbox", () => this.readDropbox(course, le, rep)],
      ["quizzes", () => this.readQuizzes(course, le, rep)],
      ["discussions", () => this.readDiscussions(course, le, rep)],
    ];
    rep.discussionsPartial = 0;
    for (const [name, run] of tools) {
      try {
        const rows = await run();
        source = name;
        rows.forEach((x) => add(x, "tool"));
        rep.tools[name] = rows.length;
        okCount++;
        if (!(name === "discussions" && rep.discussionsPartial)) sourcesOk.push(name);
      } catch (e) {
        if (e.code === "signed-out") throw e;
        rep.tools[name] = `failed: ${e.code || e.message}`;
        failCount++;
      }
    }

    const feed = await this.ensureFeed();
    source = "feed";
    let fromFeed = 0;
    for (const x of feed.items) {
      if (Number(x.OrgUnitId) !== ou || x.IsExempt === true) continue;
      const dueAt = isoOrNull(x.DueDate) || isoOrNull(x.EndDate);
      if (!dueAt) continue;
      const kind = kindOf(x);
      const url = absolute(this.base, x.ItemUrl);
      const sourceId = toolIdFromUrl(kind, url) || String(x.ItemId);
      add(
        {
          kind,
          sourceId,
          title: String(x.ItemName || "Learn item"),
          dueAt,
          dueField: fieldOf(x.DueDate),
          opensAt: laterOnly(isoOrNull(x.StartDate), dueAt),
          url,
          completedAt: feed.completed.get(`${x.OrgUnitId}:${x.ItemId}`) || null,
        },
        "feed"
      );
      fromFeed++;
    }
    rep.tools.myItems = feed.ok ? fromFeed : "failed";
    if (feed.ok) okCount++;
    else failCount++;

    const cal = await this.calendarFor(course, le);
    if (cal.ok) {
      source = "calendar";
      const { rows, opens } = this.calendarRows(cal.events, rep);
      rows.forEach((x) => add(x, "calendar"));
      // A start event for an item another source found.
      for (const item of byKey.values()) {
        const o = opens.get(`${item.kind}:${item.id.split(":").slice(2).join(":")}`);
        if (o && !item.opensAt && o < item.dueAt) item.opensAt = o;
      }
      rep.tools.calendar = rows.length;
      okCount++;
    } else {
      rep.tools.calendar = `failed: ${cal.error && cal.error.code}`;
      failCount++;
    }

    if (!okCount && failCount) {
      const err = new Error(`Could not read anything for ${course.code}`);
      err.code = "course-failed";
      throw err;
    }
    const okSources = new Set(sourcesOk);
    if (feed.ok && !feed.missed.has(ou)) okSources.add("feed");
    if (cal.ok) okSources.add("calendar");
    this.readOk.set(course.id, okSources);
    rep.readOk = [...okSources];
    const items = dropEchoes([...new Set(byKey.values())]);
    for (const i of items) {
      i.seenIn = [...i.seen];
      delete i.srcs;
      delete i.seen;
    }
    rep.items = items.length;
    rep.submitted = items.filter((i) => i.status === "submitted").length;
    return items;
  }

  /**
   * Decides whether a unit with no term clue stays. It stays only when it has an
   * open item due from now on, and then only its items from the last two weeks
   * onward are shown. Returns the items to keep, or null to drop the unit.
   */
  keepTermless(course, items) {
    const now = this.now.getTime();
    const upcoming = items.filter((i) => i.status === "open" && Date.parse(i.dueAt) >= now);
    const rep = this.report.courses.find((c) => c.orgUnitId === course.orgUnitId);
    if (rep) rep.termless = upcoming.length ? `kept, ${upcoming.length} upcoming` : "dropped, nothing upcoming";
    if (!upcoming.length) return null;
    return items.filter((i) => Date.parse(i.dueAt) >= now - 14 * DAY_MS);
  }

  /**
   * Asks Learn whether one dropbox folder or quiz is handed in, right before a
   * reminder goes out. Tries the worker first, then an open Learn tab.
   * Resolves to { submitted: true, at } or { submitted: false }, or null when
   * Learn could not be asked (the reminder then goes out anyway).
   */
  async submissionState(item) {
    const [ouText, kind, ...rest] = String(item.id || "").split(":");
    const ou = Number(ouText);
    const sourceId = rest.join(":");
    if (!ou || !/^\d+$/.test(sourceId) || (kind !== "dropbox" && kind !== "quiz")) return null;
    const vias = this.relay ? ["worker", "tab"] : ["worker"];
    for (const via of vias) {
      try {
        const { le } = await this.ensureVersions(via);
        if (kind === "dropbox") {
          const subs = listOf(await this.api(`/d2l/api/le/${le}/${ou}/dropbox/folders/${sourceId}/submissions/mysubmissions/`, { via }));
          const dates = [];
          for (const x of subs) {
            for (const y of x && Array.isArray(x.Submissions) ? x.Submissions : [x]) if (y) dates.push(isoOrNull(y.SubmissionDate) || new Date().toISOString());
          }
          return dates.length ? { submitted: true, at: dates.sort().pop() } : { submitted: false };
        }
        // Quizzes: Learn's completions feed for this one course.
        const { from } = this.window();
        const q = new URLSearchParams({ orgUnitIdsCSV: String(ou), completedFromDateTime: from, completedToDateTime: utcDateTime(Date.now() + DAY_MS) });
        const rows = [];
        for (const route of ["completions/due/", "completions/"]) {
          const page = await this.api(`/d2l/api/le/${le}/content/myItems/${route}?${q}`, { via });
          rows.push(...listOf(page));
        }
        const hit = rows.find((x) => {
          if (!x || Number(x.OrgUnitId) !== ou) return false;
          const id = toolIdFromUrl("quiz", absolute(this.base, x.ItemUrl));
          return id ? id === sourceId : norm(x.ItemName) === norm(item.title);
        });
        if (!hit) return { submitted: false };
        return { submitted: true, at: isoOrNull(hit.DateCompleted) || isoOrNull(hit.CompletionDate) || new Date().toISOString() };
      } catch (e) {
        this.report.notes.push(`submission check via ${via} failed (${e.code || "error"})`);
      }
    }
    return null;
  }

  /** Called by the background once a sync ends. */
  finishReport(extra = {}) {
    Object.assign(this.report, extra, { finishedAt: new Date().toISOString() });
    const failed = this.report.requests.filter((r) => r.error);
    this.report.failedRequests = failed.length;
    return this.report;
  }
}
