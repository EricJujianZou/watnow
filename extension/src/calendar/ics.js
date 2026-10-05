/*
  The events as an iCalendar file (RFC 5545).

  This is the calendar that needs nothing: no account, no sign-in, no server.
  It produces one .ics the student imports into Google Calendar, Apple Calendar,
  Outlook or anything else that reads the format.

  Because every event keeps the uid WATnow gave it, importing the file a second
  time changes the events that are already there instead of making a second set,
  and SEQUENCE going up is what tells a calendar which copy is newer. A deadline
  that has gone is written out as CANCELLED for a while, which is how the format
  says an event is off, so a re-import can clear it too.

  What the format asks for and is easy to get wrong:
    - CRLF between lines, always.
    - Lines folded at 75 octets, counted in UTF-8 bytes rather than characters,
      continued with a leading space.
    - Backslash, semicolon and comma escaped in text, newlines written as \n.
    - UTC timestamps as yyyyMMddTHHmmssZ.
  See src/calendar/events.js for where the events come from.
*/

import { CALENDAR_NAME } from "./events.js";

const CRLF = "\r\n";
const FOLD_OCTETS = 75;

/** yyyyMMddTHHmmssZ */
export function icsDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

/** Escapes the four characters the format reserves inside a text value. */
export function icsText(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds one content line to 75 octets.
 *
 * The limit is in octets, not characters, and a multi-byte character must not
 * be split across the fold, so this measures as it goes rather than slicing by
 * length. A course title with an accent or a dash in it is the usual way a
 * naive fold produces a file the calendar then rejects.
 */
export function fold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= FOLD_OCTETS) return line;
  const out = [];
  let current = "";
  let octets = 0;
  // A continuation line starts with a space, which costs one of its octets.
  let limit = FOLD_OCTETS;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (octets + size > limit) {
      out.push(current);
      current = "";
      octets = 0;
      limit = FOLD_OCTETS - 1;
    }
    current += ch;
    octets += size;
  }
  if (current) out.push(current);
  return out.join(`${CRLF} `);
}

function line(name, value) {
  return fold(`${name}:${value}`);
}

/**
 * One VEVENT. A cancelled one carries only what is needed to find and clear it.
 * @param {object} ev        From buildEvent, plus seq
 * @param {Date} stamp       When this file was written
 * @param {boolean} cancelled
 */
function vevent(ev, stamp, cancelled = false) {
  const out = ["BEGIN:VEVENT", line("UID", ev.uid), line("DTSTAMP", icsDate(stamp)), line("SEQUENCE", String(ev.seq || 0))];
  if (cancelled) {
    out.push(line("STATUS", "CANCELLED"));
    // A cancellation still needs a start, so the one it had is repeated.
    out.push(line("DTSTART", icsDate(ev.start || stamp)));
    out.push(line("SUMMARY", icsText(ev.title || "Removed")));
  } else {
    out.push(line("DTSTART", icsDate(ev.start)));
    out.push(line("DTEND", icsDate(ev.end)));
    out.push(line("SUMMARY", icsText(ev.title)));
    if (ev.description) out.push(line("DESCRIPTION", icsText(ev.description)));
    if (ev.url) out.push(line("URL", icsText(ev.url)));
    out.push(line("STATUS", "CONFIRMED"));
    out.push(line("TRANSP", "TRANSPARENT"));
  }
  out.push(line("LAST-MODIFIED", icsDate(stamp)));
  out.push("END:VEVENT");
  return out;
}

/**
 * The whole calendar as one string.
 *
 * @param {Array} events     Current events, from buildEvents
 * @param {object} [opts]
 * @param {Array} [opts.cancelled]  Events to write out as off
 * @param {object} [opts.seqOf]     uid -> SEQUENCE, from the sync index
 * @param {Date} [opts.now]
 */
export function toIcs(events, { cancelled = [], seqOf = {}, now = new Date(), name = CALENDAR_NAME } = {}) {
  const seq = (ev) => (ev.seq != null ? ev.seq : (seqOf[ev.uid] && seqOf[ev.uid].seq) || 0);
  const lines = [
    "BEGIN:VCALENDAR",
    line("PRODID", "-//WATnow//Deadlines//EN"),
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    line("X-WR-CALNAME", icsText(name)),
    line("X-WR-TIMEZONE", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
  ];
  for (const ev of events) lines.push(...vevent({ ...ev, seq: seq(ev) }, now, false));
  for (const ev of cancelled) lines.push(...vevent({ ...ev, seq: seq(ev) }, now, true));
  lines.push("END:VCALENDAR");
  // A trailing CRLF: the format wants every content line ended, the last one too.
  return `${lines.join(CRLF)}${CRLF}`;
}

/** What the downloaded file is called. */
export function icsFilename(now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  return `watnow-deadlines-${d}.ics`;
}
