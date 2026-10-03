/*
  DEMO fixture data. This is the one file to edit so the demo matches your real
  courses. The mock Learn site reads the same data through the extension, so
  course codes, names and items you change here show up on both.

  Dates are relative to the moment you reset the demo, so the video always
  looks current:
    due: { days: 3, at: "23:59" }   three days from today at 11:59 pm
    due: { days: 0, at: "23:59" }   today at 11:59 pm
    due: { days: -1, at: "23:59" }  yesterday (shows as overdue if still open)
    due: { inMinutes: 120 }         two hours from reset, rounded to the next 5 minutes

  After editing, open the extension settings and press "Reset demo" (or reload
  the extension on chrome://extensions).

  color is one of: pink, green, orange, blue, violet, mint
  kind is the Learn tool: dropbox, quiz, discussion, content
  category drives reminder settings: assignment, lab, quiz, discussion, content
  status is "open" or "submitted"
*/

export const STUDENT = {
  name: "Jordan Lee",
  initials: "JL",
};

export const TERM = "Fall 2026";

export const COURSES = [
  { id: "cs341", code: "CS 341", name: "Algorithms", orgUnitId: 1181341, color: "pink" },
  { id: "math239", code: "MATH 239", name: "Introduction to Combinatorics", orgUnitId: 1181239, color: "green" },
  { id: "stat230", code: "STAT 230", name: "Probability", orgUnitId: 1181230, color: "orange" },
  { id: "econ101", code: "ECON 101", name: "Introduction to Microeconomics", orgUnitId: 1181101, color: "blue" },
  { id: "psych101", code: "PSYCH 101", name: "Introductory Psychology", orgUnitId: 1181102, color: "violet" },
];

export const ITEMS = [
  // CS 341
  { id: "cs341-integrity", course: "cs341", kind: "quiz", category: "quiz", title: "Academic Integrity Quiz", due: { days: -3, at: "23:59" }, status: "submitted" },
  { id: "cs341-t1", course: "cs341", kind: "content", category: "content", title: "Tutorial 1 Problems", due: { days: 2, at: "17:00" }, status: "open" },
  { id: "cs341-a1", course: "cs341", kind: "dropbox", category: "assignment", title: "Assignment 1", due: { days: 3, at: "23:59" }, status: "open",
    details: "Divide and conquer and recurrences. Submit one PDF with your written solutions." },
  { id: "cs341-a2", course: "cs341", kind: "dropbox", category: "assignment", title: "Assignment 2", due: { days: 17, at: "23:59" }, status: "open" },

  // MATH 239
  { id: "math239-w1", course: "math239", kind: "content", category: "content", title: "Week 1 Lecture Check", due: { days: -1, at: "23:59" }, status: "submitted" },
  { id: "math239-q1", course: "math239", kind: "quiz", category: "quiz", title: "Quiz 1: Counting", due: { days: 1, at: "10:00" }, status: "open" },
  { id: "math239-a1", course: "math239", kind: "dropbox", category: "assignment", title: "Assignment 1", due: { days: 4, at: "17:00" }, status: "open" },
  { id: "math239-a2", course: "math239", kind: "dropbox", category: "assignment", title: "Assignment 2", due: { days: 11, at: "17:00" }, status: "open" },
  { id: "math239-a3", course: "math239", kind: "dropbox", category: "assignment", title: "Assignment 3", due: { days: 18, at: "17:00" }, status: "open" },

  // STAT 230
  { id: "stat230-a1", course: "stat230", kind: "dropbox", category: "assignment", title: "Assignment 1", due: { days: 0, at: "23:59" }, status: "open",
    details: "Questions 1 to 6 from the Week 1 problem set. Upload a single PDF. Handwritten work is fine if the scan is readable." },
  { id: "stat230-l1", course: "stat230", kind: "dropbox", category: "lab", title: "Lab 1: Simulation in R", due: { days: 2, at: "23:59" }, status: "submitted" },
  { id: "stat230-q2", course: "stat230", kind: "quiz", category: "quiz", title: "Week 2 Quiz", due: { days: 6, at: "23:59" }, status: "open" },
  { id: "stat230-l2", course: "stat230", kind: "dropbox", category: "lab", title: "Lab 2: Discrete Distributions", due: { days: 9, at: "23:59" }, status: "open" },
  { id: "stat230-a2", course: "stat230", kind: "dropbox", category: "assignment", title: "Assignment 2", due: { days: 14, at: "23:59" }, status: "open" },

  // ECON 101
  { id: "econ101-d1", course: "econ101", kind: "discussion", category: "discussion", title: "Week 1 Discussion: Opportunity Cost", due: { days: -1, at: "23:59" }, status: "open" },
  { id: "econ101-q1", course: "econ101", kind: "quiz", category: "quiz", title: "Quiz 1: Supply and Demand", due: { days: 2, at: "23:59" }, status: "submitted" },
  { id: "econ101-ps1", course: "econ101", kind: "dropbox", category: "assignment", title: "Problem Set 1", due: { days: 9, at: "23:59" }, status: "open" },
  { id: "econ101-d3", course: "econ101", kind: "discussion", category: "discussion", title: "Week 3 Discussion: Elasticity", due: { days: 15, at: "23:59" }, status: "open" },

  // PSYCH 101
  { id: "psych101-syllabus", course: "psych101", kind: "quiz", category: "quiz", title: "Syllabus Quiz", due: { days: -4, at: "23:59" }, status: "submitted" },
  { id: "psych101-q1", course: "psych101", kind: "quiz", category: "quiz", title: "Chapter 1 Quiz", due: { inMinutes: 120 }, status: "open" },
  { id: "psych101-d2", course: "psych101", kind: "discussion", category: "discussion", title: "Week 2 Discussion: Memory Myths", due: { days: 5, at: "23:59" }, status: "open" },
  { id: "psych101-q2", course: "psych101", kind: "quiz", category: "quiz", title: "Chapter 2 Quiz", due: { days: 7, at: "23:59" }, status: "open" },
  { id: "psych101-r1", course: "psych101", kind: "dropbox", category: "assignment", title: "Reflection Paper 1", due: { days: 16, at: "23:59" }, status: "open" },
];

/*
  What the demo shortcuts do.
  moves: each press of "prof moves a date" applies the next move in this list.
  reminder: the item the reminder shortcut uses (falls back to the next open item due soonest).
  scanDelays: how long "reading" each course takes on first open, in milliseconds.
*/
export const DEMO_SCRIPT = {
  moves: [
    { itemId: "cs341-a1", shiftDays: 5 },
    { itemId: "econ101-ps1", shiftDays: 2 },
  ],
  reminder: { itemId: "psych101-q1" },
  scanDelays: [760, 900, 640, 820, 700],
};
