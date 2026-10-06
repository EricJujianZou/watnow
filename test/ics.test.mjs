// src/calendar/ics.js: the iCalendar file.
//
// The last block reads the file back with ical.js rather than with the code
// that wrote it, so the format is checked by something that did not learn it
// from the same place.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";

import { buildEvents, planSync } from "../extension/src/calendar/events.js";
import { toIcs, fold, icsText, icsDate, icsFilename } from "../extension/src/calendar/ics.js";

const COURSES = [{ id: "c1", code: "ECE 207", name: "Signals and Systems", color: "blue" }];
const NOW = new Date("2026-10-04T12:00:00Z");
const enc = new TextEncoder();

const ITEMS = [
  { id: "99001:dropbox:4421", courseId: "c1", kind: "dropbox", category: "assignment", title: "Lab 3 Report", dueAt: "2026-10-10T03:59:00Z", url: "https://learn.uwaterloo.ca/d2l/x", status: "open", completedAt: null },
  // Every character the format reserves, plus a fold and a multi-byte run.
  { id: "cm:abc", courseId: "c1", kind: "crowdmark", category: "assignment", status: "submitted", completedAt: "2026-10-11T10:00:00Z", url: "https://app.crowdmark.com/student/assessments/abc", dueAt: "2026-10-12T20:00:00Z", title: "A2; commas, backslash \\ and a long title that will certainly need folding across more than one line éééééééééé" },
];

const build = () => {
  const events = buildEvents(ITEMS, COURSES);
  const plan = planSync({}, events, NOW);
  return { events, plan, ics: toIcs(events, { seqOf: plan.index, now: NOW }) };
};

describe("escaping and dates", () => {
  test("the four reserved characters are escaped", () => {
    assert.equal(icsText("a;b,c\\d\ne"), "a\\;b\\,c\\\\d\\ne");
  });

  test("timestamps are UTC in basic form", () => {
    assert.equal(icsDate(new Date("2026-10-10T03:59:00Z")), "20261010T035900Z");
  });

  test("the filename carries the day it was made", () => {
    assert.equal(icsFilename(NOW), "watnow-deadlines-2026-10-04.ics");
  });
});

describe("folding", () => {
  test("a short line is left alone", () => {
    assert.equal(fold("UID:abc"), "UID:abc");
  });

  test("a long line is folded and unfolds back to the original", () => {
    const line = "SUMMARY:" + "a".repeat(200);
    const folded = fold(line);
    assert.ok(folded.split("\r\n").every((l) => enc.encode(l).length <= 75));
    assert.equal(folded.replace(/\r\n /g, ""), line);
  });

  test("the limit is octets, so a multi-byte character is never split", () => {
    // Each of these is two octets: counting characters would overshoot the limit.
    const line = "SUMMARY:" + "é".repeat(120);
    const folded = fold(line);
    assert.ok(
      folded.split("\r\n").every((l) => enc.encode(l).length <= 75),
      folded.split("\r\n").map((l) => enc.encode(l).length).join(","),
    );
    assert.equal(folded.replace(/\r\n /g, ""), line);
  });
});

describe("the file", () => {
  const { ics } = build();

  test("every line ends CRLF, including the last", () => {
    assert.ok(ics.endsWith("\r\n"));
    assert.doesNotMatch(ics, /[^\r]\n/);
  });

  test("it opens and closes a VCALENDAR with one VEVENT per event", () => {
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.equal((ics.match(/END:VEVENT/g) || []).length, 2);
  });

  test("no line is over 75 octets", () => {
    const over = ics.split("\r\n").filter((l) => enc.encode(l).length > 75);
    assert.deepEqual(over, []);
  });

  test("a removal is written out as cancelled, keeping its uid", () => {
    const { events } = build();
    const out = toIcs([], { cancelled: [{ ...events[0], seq: 1 }], now: NOW });
    assert.match(out, /STATUS:CANCELLED/);
    assert.ok(out.includes(`UID:${events[0].uid}`));
    assert.match(out, /SEQUENCE:1/);
  });
});

describe("read back by ical.js", () => {
  const { events, ics } = build();
  const comp = new ICAL.Component(ICAL.parse(ics));
  const byUid = Object.fromEntries(comp.getAllSubcomponents("vevent").map((v) => [v.getFirstPropertyValue("uid"), v]));

  test("it parses, as a VCALENDAR 2.0", () => {
    assert.equal(comp.name, "vcalendar");
    assert.equal(comp.getFirstPropertyValue("version"), "2.0");
  });

  test("the dates survive the round trip", () => {
    const ev = new ICAL.Event(byUid[events[0].uid]);
    assert.equal(ev.endDate.toJSDate().toISOString(), "2026-10-10T03:59:00.000Z");
    assert.equal(ev.startDate.toJSDate().toISOString(), "2026-10-10T03:29:00.000Z");
  });

  test("a title full of reserved characters comes back exactly as it went in", () => {
    const ev = new ICAL.Event(byUid[events[1].uid]);
    assert.equal(ev.summary, "✓ ECE 207: " + ITEMS[1].title);
  });

  test("the description keeps its real newlines, and the link survives", () => {
    const ev = new ICAL.Event(byUid[events[1].uid]);
    assert.match(ev.description, /\n/);
    assert.match(ev.description, /on Crowdmark/);
    assert.equal(byUid[events[0].uid].getFirstPropertyValue("url"), "https://learn.uwaterloo.ca/d2l/x");
  });
});
