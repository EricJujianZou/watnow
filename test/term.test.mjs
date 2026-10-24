// termFromText in src/data/live-source.js: which term a course name or code is for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { termFromText } from "../extension/src/data/live-source.js";

test("Waterloo codes and spelled-out terms read as before", () => {
  assert.equal(termFromText("MATH135_1269"), 1269);
  assert.equal(termFromText("MATH 115 - Fall 2026"), 1269);
  assert.equal(termFromText("Winter 2027", false), 1271);
});

test("the short form: F26, W27, S26", () => {
  assert.equal(termFromText("ENGRM_F26"), 1269, "Waterloo's Engineering Ready code");
  assert.equal(termFromText("PHYS*1080*0101 Physics for Life Sciences (F26)", false), 1269);
  assert.equal(termFromText("CHEM*1040 W27", false), 1271);
  assert.equal(termFromText("ACCT*1220 S26", false), 1265);
});

test("things that only look like one aren't", () => {
  assert.equal(termFromText("STAT*2040*S01", false), null, "a section number");
  assert.equal(termFromText("F2F tutorial", false), null);
  assert.equal(termFromText("Room F26A", false), null);
  assert.equal(termFromText("Residence Experience", false), null);
});
