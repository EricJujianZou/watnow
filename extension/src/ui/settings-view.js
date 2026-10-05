// Reminder, appearance and privacy settings. Mounted in the side panel and on the settings page.

import { getSettings, setSettings } from "../core/store.js";
import { TESTER_BUILD } from "../core/build.js";
import { IS_GECKO } from "../core/env.js";
import { GOOGLE_BOUNCE_URL, googleConfigured } from "../calendar/google-config.js";
import { LEADS, REMINDER_TYPES } from "../core/reminders.js";
import { icon, esc } from "./icons.js";

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

const SOURCE_HELP = {
  live: "Reads your courses from your school's course site with the session signed in on this browser.",
  demo: "Shows made-up courses from the demo. Nothing is read from Learn.",
};

const DEBUG_LINK = "Found a bug? Send Eric the debug report via Instagram @sleppyeric and he'll buy you a coffee :)";

// Chrome can keep running after its last window closes, so reminders can still
// go out. Gecko has no such setting, so that half of the note is dropped there.
const BACKGROUND_STEPS = [
  "Open the three dot menu at the top right of Chrome.",
  "Choose Settings, then System in the left sidebar.",
  "Turn on Continue running background apps when Google Chrome is closed.",
];

function remindersNote() {
  if (IS_GECKO) {
    return `<p class="note">${icon("info", 18)}<span>Notifications only show while your browser is open.</span></p>`;
  }
  return `<p class="note">${icon("info", 18)}<span>Notifications only show while Chrome is open. To keep getting them after you close every Chrome window, turn on <button class="tip-btn" data-act="bg-tip" aria-expanded="false">Continue running background apps</button> in Chrome's system settings.</span></p>
      <div data-bg-tip></div>`;
}

function sourceSection(s) {
  const mode = s.mode === "live" ? "live" : "demo";
  const opt = (v, label) => `<label><input type="radio" name="mode" value="${v}" ${mode === v ? "checked" : ""}><span>${label}</span></label>`;
  return `
    <section class="set-section" aria-labelledby="set-src">
      <h2 id="set-src">Where deadlines come from</h2>
      <div class="seg" role="radiogroup" aria-labelledby="set-src">
        ${opt("live", "Learn")}${opt("demo", "Demo data")}
      </div>
      <p class="set-help" data-src-help style="margin-top:10px">${esc(SOURCE_HELP[mode])}</p>
    </section>`;
}

function leadIndex(id) {
  const i = LEADS.findIndex((l) => l.id === id);
  return i === -1 ? LEADS.findIndex((l) => l.id === "2d") : i;
}

/** One deadline type: a switch, and a slider for how early its reminder goes out. */
function leadRow(type, s) {
  const on = !(s.reminders.offTypes || []).includes(type.id);
  const idx = leadIndex((s.reminders.leads[type.id] || [])[0]);
  return `
    <li class="lead-row${on ? "" : " is-off"}" data-lead-row="${type.id}">
      <div class="lead-head">
        <span class="lead-name">${esc(type.label)}</span>
        <button class="switch" role="switch" data-type-toggle="${type.id}" aria-checked="${on}" aria-label="${esc(`Remind me about ${type.label.toLowerCase()}`)}"></button>
      </div>
      <p class="lead-value" data-lead-value="${type.id}">${esc(LEADS[idx].label)}</p>
      <input class="slider" type="range" min="0" max="${LEADS.length - 1}" step="1" value="${idx}"
        data-lead-slider="${type.id}" ${on ? "" : "disabled"}
        aria-label="${esc(`How early to remind me about ${type.label.toLowerCase()}`)}">
      <div class="slider-scale" aria-hidden="true">${LEADS.map(
        (l, i) => `<span style="--p:${(i / (LEADS.length - 1)).toFixed(4)}">${esc(l.short)}</span>`
      ).join("")}</div>
    </li>`;
}

/**
 * Google Calendar, when this build is set up for it.
 *
 * Gecko gives every install its own sign-in address, which Google will not
 * redirect to, so without a bounce page to stand in for it there is nothing to
 * offer there but the file. See src/calendar/google.js.
 */
function googleSection() {
  if (!googleConfigured()) return "";
  if (IS_GECKO && !GOOGLE_BOUNCE_URL) {
    return `<p class="set-help" style="margin-top:18px">Google Calendar can't connect itself on this browser, so use the file above. It imports into Google Calendar the same way.</p>`;
  }
  return `
    <h3 style="margin-top:22px">Google Calendar</h3>
    <p class="set-help">Keep a WATnow calendar in Google that updates itself whenever your deadlines change. WATnow makes a calendar of its own and only ever touches that one, so it can't see anything else in your Google account.</p>
    <div class="row-actions" style="margin-top:14px" data-google-actions></div>
    <p class="status-text" data-google-status role="status"></p>`;
}

function template(s, courses, context) {
  const r = s.reminders;
  const leadRows = REMINDER_TYPES.map((t) => leadRow(t, s)).join("");

  const courseList = courses.length
    ? `<ul class="course-toggles">${courses
        .map((c) => {
          const on = !r.mutedCourses.includes(c.id);
          return `<li class="hl-${c.color}${on ? "" : " is-muted"}" data-course-row="${c.id}"><span class="ct-text"><span class="chip">${esc(c.code)}</span><span class="ct-name">${esc(c.name)}</span></span><button class="switch" role="switch" data-course="${c.id}" aria-checked="${on}" aria-label="${esc(`Reminders for ${c.code}`)}"></button></li>`;
        })
        .join("")}</ul>`
    : `<p class="set-help">Your courses show up here after WATnow reads Learn.</p>`;

  const theme = (v, label) => `<label><input type="radio" name="theme" value="${v}" ${s.theme === v ? "checked" : ""}><span>${label}</span></label>`;

  return `
  <div class="settings">
    ${context === "panel" && !TESTER_BUILD ? sourceSection(s) : ""}
    <section class="set-section" aria-labelledby="set-rem">
      <h2 id="set-rem">Reminders</h2>
      <h3>Deadline type</h3>
      <ul class="lead-list">${leadRows}</ul>

      <h3>I want reminders for these courses</h3>
      ${courseList}

      ${remindersNote()}
    </section>

    <section class="set-section" aria-labelledby="set-look">
      <h2 id="set-look">Appearance</h2>
      <div class="seg" role="radiogroup" aria-labelledby="set-look">
        ${theme("system", "Match system")}${theme("light", "Light")}${theme("dark", "Dark")}
      </div>
    </section>

    <section class="set-section" aria-labelledby="set-cal">
      <h2 id="set-cal">Calendar</h2>
      <p class="set-help">Put your deadlines in Google Calendar, Apple Calendar, Outlook or anything else that reads calendar files. Importing the file again later moves the dates that changed rather than making a second copy of everything.</p>
      <div class="row-actions" style="margin-top:14px">
        <button class="btn btn-primary btn-sm" data-act="cal-export">Export my deadlines</button>
      </div>
      <p class="status-text" data-cal-status role="status"></p>
      ${googleSection()}
    </section>

    <section class="set-section" aria-labelledby="set-data">
      <h2 id="set-data">My data</h2>
      <p class="note" style="margin-top:6px">${icon("lock", 18)}<span>WATnow reads Learn with the session that's already signed in on this browser, so it never sees your password. Your deadlines and settings stay on this computer.</span></p>
      <div style="margin-top:16px" data-delete-area>
        <button class="btn btn-danger btn-sm" data-act="ask-delete">Delete my data</button>
      </div>
      ${context === "panel" ? `<p style="margin:18px 0 0"><button class="link-btn" data-act="open-options">${esc(DEBUG_LINK)}</button></p>` : ""}
    </section>
  </div>`;
}

/**
 * Hands the file to the browser's downloads.
 *
 * A link with download on it needs no permission, which a downloads API call
 * would. The object URL is let go on the next turn of the loop, once the click
 * has been taken.
 */
/** Connected or not, asked fresh each time settings opens. */
async function renderGoogle(root) {
  const slot = root.querySelector("[data-google-actions]");
  if (!slot) return;
  const res = await chrome.runtime.sendMessage({ type: "calendar:google-state" }).catch(() => null);
  const connected = Boolean(res && res.connected);
  slot.innerHTML = connected
    ? `<button class="btn btn-quiet btn-sm" data-act="google-off">Disconnect Google Calendar</button>`
    : `<button class="btn btn-primary btn-sm" data-act="google-on">Connect Google Calendar</button>`;
  const status = root.querySelector("[data-google-status]");
  if (status && connected) status.textContent = "Connected. Your deadlines go to the WATnow calendar in Google as they change.";
}

function saveIcs(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

export async function mountSettings(root, { courses = [], context = "panel", onDeleted } = {}) {
  let settings = await getSettings();
  root.innerHTML = template(settings, courses, context);
  renderGoogle(root);

  // The panel mounts settings into the same element every time it is opened, so
  // the listeners are attached once. Two copies would cancel each other out.
  if (root.dataset.settingsWired === "1") return;
  root.dataset.settingsWired = "1";

  const save = async (fn) => {
    settings = await setSettings(fn);
    chrome.runtime.sendMessage({ type: "settings:changed" }).catch(() => {});
  };

  root.addEventListener("input", (e) => {
    const t = e.target;
    if (!t.matches("input[data-lead-slider]")) return;
    const type = t.dataset.leadSlider;
    const lead = LEADS[Number(t.value)] || LEADS[0];
    const label = root.querySelector(`[data-lead-value="${type}"]`);
    if (label) label.textContent = lead.label;
  });

  root.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.matches("input[data-lead-slider]")) {
      const type = t.dataset.leadSlider;
      const lead = LEADS[Number(t.value)] || LEADS[0];
      await save((s) => {
        s.reminders.leads[type] = [lead.id];
        return s;
      });
    } else if (t.matches('input[name="mode"]')) {
      const v = t.value === "live" ? "live" : "demo";
      const help = root.querySelector("[data-src-help]");
      if (help) help.textContent = SOURCE_HELP[v];
      await save((s) => {
        s.mode = v;
        return s;
      });
    } else if (t.matches('input[name="theme"]')) {
      const v = t.value;
      applyTheme(v);
      await save((s) => {
        s.theme = v;
        return s;
      });
    }
  });

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-course], [data-type-toggle], [data-act]");
    if (!t) return;

    if (t.dataset.act === "google-on" || t.dataset.act === "google-off") {
      const on = t.dataset.act === "google-on";
      const status = root.querySelector("[data-google-status]");
      t.disabled = true;
      status.textContent = on ? "Opening Google to sign in…" : "Disconnecting…";
      const res = await chrome.runtime.sendMessage({ type: on ? "calendar:google-connect" : "calendar:google-disconnect" }).catch(() => null);
      t.disabled = false;
      if (on && (!res || !res.ok)) {
        const why = res && res.reason === "refused" ? "Google didn't give WATnow access." : res && res.reason === "cancelled" ? "The sign-in was closed before it finished." : "That didn't work.";
        status.textContent = `${why} Select Connect Google Calendar to try again.`;
        return;
      }
      await renderGoogle(root);
      if (!on) status.textContent = "Disconnected. The WATnow calendar in Google is gone; nothing else was touched.";
      return;
    }

    if (t.dataset.act === "cal-export") {
      const status = root.querySelector("[data-cal-status]");
      t.disabled = true;
      status.textContent = "Building your calendar file…";
      const res = await chrome.runtime.sendMessage({ type: "calendar:export" }).catch(() => null);
      t.disabled = false;
      if (!res || !res.ok || !res.ics) {
        status.textContent = "That didn't work. Try again once WATnow has read your deadlines.";
        return;
      }
      if (!res.counts.events) {
        status.textContent = "There are no dated deadlines to export yet.";
        return;
      }
      saveIcs(res.ics, res.filename);
      status.textContent = `${res.counts.events} ${res.counts.events === 1 ? "deadline" : "deadlines"} saved as ${res.filename}. Import it into your calendar.`;
      return;
    }

    if (t.dataset.typeToggle) {
      const id = t.dataset.typeToggle;
      const on = t.getAttribute("aria-checked") !== "true";
      t.setAttribute("aria-checked", String(on));
      const row = t.closest(".lead-row");
      row.classList.toggle("is-off", !on);
      const slider = row.querySelector(".slider");
      if (slider) slider.disabled = !on;
      await save((s) => {
        const off = new Set(s.reminders.offTypes || []);
        if (on) off.delete(id);
        else off.add(id);
        s.reminders.offTypes = [...off];
        return s;
      });
      return;
    }

    if (t.dataset.course) {
      const id = t.dataset.course;
      const on = t.getAttribute("aria-checked") !== "true";
      t.setAttribute("aria-checked", String(on));
      t.closest("li").classList.toggle("is-muted", !on);
      await save((s) => {
        const muted = new Set(s.reminders.mutedCourses);
        if (on) muted.delete(id);
        else muted.add(id);
        s.reminders.mutedCourses = [...muted];
        return s;
      });
      return;
    }

    if (t.dataset.act === "bg-tip") {
      const box = root.querySelector("[data-bg-tip]");
      const open = t.getAttribute("aria-expanded") === "true";
      t.setAttribute("aria-expanded", String(!open));
      box.innerHTML = open
        ? ""
        : `<div class="tip" role="note"><h4>Keep reminders coming after you close Chrome</h4><ol>${BACKGROUND_STEPS.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>`;
      return;
    }

    const area = root.querySelector("[data-delete-area]");
    switch (t.dataset.act) {
      case "ask-delete":
        area.innerHTML = `<div class="confirm" role="group" aria-label="Confirm delete">
          <p>This deletes everything WATnow saved on this computer, including the items you checked off.</p>
          <div class="row-actions">
            <button class="btn btn-danger-solid btn-sm" data-act="confirm-delete">Delete</button>
            <button class="btn btn-quiet btn-sm" data-act="cancel-delete">Keep my data</button>
          </div></div>`;
        area.querySelector('[data-act="cancel-delete"]').focus();
        break;
      case "cancel-delete":
        area.innerHTML = `<button class="btn btn-danger btn-sm" data-act="ask-delete">Delete my data</button>`;
        area.querySelector("button").focus();
        break;
      case "confirm-delete":
        await chrome.runtime.sendMessage({ type: "data:delete" });
        area.innerHTML = `<p class="status-text" role="status">Your data is deleted. WATnow has nothing saved on this computer now.</p>`;
        if (onDeleted) onDeleted();
        break;
      case "open-options":
        chrome.runtime.openOptionsPage();
        break;
    }
  });
}
