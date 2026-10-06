// src/calendar/events.js: deadlines as events, and working out what changed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildEvent, buildEvents, planSync, uidFor, tombstones, TOMBSTONE_MS } from "../extension/src/calendar/events.js";

const COURSES = [
  { id: "c1", code: "ECE 207", name: "Signals and Systems", color: "blue" },
  { id: "c2", code: "PHYS 121", name: "", color: "green" },
];

const item = (over = {}) => ({
  id: "99001:dropbox:4421",
  courseId: "c1",
  kind: "dropbox",
  category: "assignment",
  title: "Lab 3 Report",
  dueAt: "2026-10-10T03:59:00.000Z",
  url: "https://learn.uwaterloo.ca/d2l/x",
  status: "open",
  completedAt: null,
  ...over,
});

const NOW = new Date("2026-10-04T12:00:00Z");

describe("one deadline as an event", () => {
  const ev = buildEvent(item(), COURSES[0]);

  test("the uid comes from the item id, and is stable between reads", () => {
    assert.equal(ev.uid, "watnow-99001-dropbox-4421@watnow.ugmi.ca");
    assert.equal(uidFor("99001:dropbox:4421"), ev.uid);
  });

  test("the title carries the course code", () => {
    assert.equal(ev.title, "ECE 207: Lab 3 Report");
  });

  test("it ends at the due time and starts half an hour before", () => {
    assert.equal(ev.end.toISOString(), "2026-10-10T03:59:00.000Z");
    assert.equal(ev.start.toISOString(), "2026-10-10T03:29:00.000Z");
  });

  test("the description names the type and keeps the link", () => {
    assert.match(ev.description, /Assignment/);
    assert.match(ev.description, /learn\.uwaterloo\.ca\/d2l\/x/);
  });

  test("an item with no usable date is not an event", () => {
    assert.equal(buildEvent(item({ dueAt: "not a date" }), COURSES[0]), null);
  });
});

describe("handing work in", () => {
  const open = buildEvent(item(), COURSES[0]);
  const done = buildEvent(item({ status: "submitted", completedAt: "2026-10-09T20:00:00Z" }), COURSES[0]);

  test("the event stays, with a check mark on the title", () => {
    assert.ok(done.title.startsWith("✓ "), done.title);
    assert.match(done.description, /Submitted/);
  });

  test("it keeps the same uid, so the calendar changes the event it has", () => {
    assert.equal(done.uid, open.uid);
  });

  test("but the fingerprint moves, so the change is sent", () => {
    assert.notEqual(done.fingerprint, open.fingerprint);
  });
});

describe("a whole read", () => {
  test("undated items are dropped and the rest come back in due order", () => {
    const events = buildEvents(
      [item({ id: "late", dueAt: "2026-11-01T00:00:00Z" }), item({ id: "undated", dueAt: "nope" }), item({ id: "soon", dueAt: "2026-10-01T00:00:00Z" })],
      COURSES,
    );
    assert.deepEqual(events.map((e) => e.itemId), ["soon", "late"]);
  });

  test("a Crowdmark item is described as one", () => {
    const [ev] = buildEvents([item({ id: "cm:abc-123", kind: "crowdmark", courseId: "c2" })], COURSES);
    assert.equal(ev.uid, "watnow-cm-abc-123@watnow.ugmi.ca");
    assert.match(ev.description, /on Crowdmark/);
  });
});

describe("what changed since last time", () => {
  const first = planSync({}, buildEvents([item()], COURSES), NOW);

  test("a new item is a create, starting at sequence 0", () => {
    assert.equal(first.creates.length, 1);
    assert.equal(first.updates.length, 0);
    assert.equal(first.creates[0].seq, 0);
    assert.equal(first.changed, true);
  });

  test("nothing changed means nothing to send", () => {
    const again = planSync(first.index, buildEvents([item()], COURSES), NOW);
    assert.equal(again.changed, false);
    assert.deepEqual([again.creates.length, again.updates.length, again.deletes.length], [0, 0, 0]);
  });

  test("a moved due date updates the event already there, with a higher sequence", () => {
    const moved = planSync(first.index, buildEvents([item({ dueAt: "2026-10-12T03:59:00Z" })], COURSES), NOW);
    assert.equal(moved.creates.length, 0);
    assert.equal(moved.updates.length, 1);
    assert.equal(moved.updates[0].seq, 1);
    assert.equal(moved.updates[0].uid, uidFor(item().id));
  });

  test("a deadline that disappeared is a delete, and is not deleted twice", () => {
    const gone = planSync(first.index, [], NOW);
    assert.equal(gone.deletes.length, 1);
    assert.ok(gone.index[uidFor(item().id)].removedAt);
    assert.equal(planSync(gone.index, [], NOW).deletes.length, 0);
  });

  test("one that comes back is a create again", () => {
    const gone = planSync(first.index, [], NOW);
    const back = planSync(gone.index, buildEvents([item()], COURSES), NOW);
    assert.equal(back.creates.length, 1);
    assert.equal(back.index[uidFor(item().id)].removedAt, undefined);
  });
});

describe("remembering removals", () => {
  const gone = planSync(planSync({}, buildEvents([item()], COURSES), NOW).index, [], NOW);

  test("a removal is offered as a cancellation while it is still remembered", () => {
    const stones = tombstones(gone.index, NOW);
    assert.equal(stones.length, 1);
    assert.equal(stones[0].uid, uidFor(item().id));
    // The title and start are kept, so the cancellation is a real event and not a placeholder.
    assert.equal(stones[0].title, "ECE 207: Lab 3 Report");
    assert.ok(stones[0].start instanceof Date);
  });

  test("and forgotten once the window has passed", () => {
    const later = new Date(NOW.getTime() + TOMBSTONE_MS + 1000);
    assert.equal(tombstones(gone.index, later).length, 0);
    assert.equal(Object.keys(planSync(gone.index, [], later).index).length, 0);
  });
});
