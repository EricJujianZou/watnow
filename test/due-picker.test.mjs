// src/ui/due-picker.js: the date and time picker in the add-deadline form.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { quickPicks, monthGrid, fmtTime } from "../extension/src/ui/due-picker.js";

const ymd = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

describe("quick picks", () => {
  test("from a Saturday: today, tomorrow, the coming Friday, a week on", () => {
    const picks = quickPicks(new Date(2026, 9, 24, 15, 0)); // Sat Oct 24
    assert.deepEqual(picks.map(([label, d]) => `${label} ${ymd(d)}`), ["Today 2026-10-24", "Tomorrow 2026-10-25", "Friday 2026-10-30", "In a week 2026-10-31"]);
  });

  test("on a Friday, Friday means next week's", () => {
    const [, , friday] = quickPicks(new Date(2026, 9, 30, 9, 0));
    assert.equal(friday[0], "Next Friday");
    assert.equal(ymd(friday[1]), "2026-11-6");
  });

  test("picks are midnight, so the chosen time is kept", () => {
    for (const [, d] of quickPicks(new Date(2026, 9, 24, 15, 30))) assert.equal(d.getHours() + d.getMinutes(), 0);
  });
});

describe("month grid", () => {
  test("six weeks, Sunday first, covering the month", () => {
    const days = monthGrid(2026, 10); // November 2026 starts on a Sunday
    assert.equal(days.length, 42);
    assert.equal(days[0].getDay(), 0);
    assert.equal(ymd(days[0]), "2026-11-1");
    assert.ok(days.some((d) => ymd(d) === "2026-11-30"));
  });

  test("a month starting midweek begins with the end of the last one", () => {
    const days = monthGrid(2026, 9); // October 2026 starts on a Thursday
    assert.equal(ymd(days[0]), "2026-9-27");
    assert.equal(ymd(days[4]), "2026-10-1");
  });
});

test("times read the way the panel writes them", () => {
  assert.equal(fmtTime(23, 59), "11:59 pm");
  assert.equal(fmtTime(0, 0), "12:00 am");
  assert.equal(fmtTime(12, 5), "12:05 pm");
  assert.equal(fmtTime(9, 0), "9:00 am");
});
