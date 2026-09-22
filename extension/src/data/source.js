/*
  Deadline data interface.

  Every data source (DEMO and LIVE) implements DeadlineSource. The rest of
  the extension only ever sees Course and Deadline objects, so switching modes
  does not touch the panel, reminders or badge code.

  @typedef {"pink"|"green"|"orange"|"blue"|"violet"|"mint"} CourseColor

  @typedef {Object} Course
  @property {string} id           Stable id inside WATnow ("cs341", or the org unit id in LIVE mode)
  @property {string} code         "CS 341"
  @property {string} name         "Algorithms"
  @property {number} orgUnitId    Brightspace org unit id for the course offering
  @property {CourseColor} color

  @typedef {"dropbox"|"quiz"|"discussion"|"content"} LearnKind      The Learn tool the item lives in
  @typedef {"assignment"|"lab"|"quiz"|"discussion"|"content"} Category  What reminders are set by

  @typedef {Object} Deadline
  @property {string} id            Stable id ("cs341-a1", or `${orgUnitId}:${kind}:${sourceId}` in LIVE mode)
  @property {string} courseId
  @property {LearnKind} kind
  @property {Category} category
  @property {string} title
  @property {string} dueAt         ISO timestamp
  @property {string} url           The item's own page on Learn
  @property {string} [listUrl]     LIVE only: the course's list page for the tool, used when the item's own page would error
  @property {string} [opensAt]     ISO timestamp the item unlocks, when Learn gives one
  @property {"open"|"submitted"|"done"} status   submitted = Learn shows it; done = the student checked it off by hand
  @property {string|null} completedAt
  @property {string} [details]     Instructions text, used by the mock Learn pages
  @property {{from: string, at: string}|null} [moved]  Set when a due date changed since the last read

  @typedef {Object} ReadProgress
  @property {string} courseId
  @property {"waiting"|"reading"|"done"|"error"} status
  @property {number} found

  @typedef {Object} DeadlineSource
  @property {"demo"|"live"} mode
  @property {() => Promise<{signedIn: boolean, student?: {name: string, initials: string}, reason?: string}>} checkSession
  @property {() => Promise<Course[]>} listCourses
  @property {(course: Course) => Promise<Deadline[]>} listDeadlines   All dated items for one course, with submission status
*/

import { DemoSource } from "./demo-source.js";
import { LiveSource } from "./live-source.js";

/**
 * @param {object} settings
 * @param {() => Promise<object>} getCatalog  DEMO only: returns the fake Learn catalog
 * @param {object} [liveOpts]  LIVE only: { relay } for reading through an open Learn tab
 * @returns {DeadlineSource}
 */
export function createSource(settings, getCatalog, liveOpts) {
  if (settings.mode === "live") return new LiveSource(settings, liveOpts);
  return new DemoSource(settings, getCatalog);
}

export const CATEGORY_LABEL = {
  assignment: "Assignment",
  lab: "Lab",
  quiz: "Quiz",
  discussion: "Discussion",
  content: "Content",
};

export const CATEGORY_PLURAL = {
  assignment: ["assignment", "assignments"],
  lab: ["lab", "labs"],
  quiz: ["quiz", "quizzes"],
  discussion: ["discussion", "discussions"],
  content: ["content item", "content items"],
};
