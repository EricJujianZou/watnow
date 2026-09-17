// Reminder, appearance and privacy settings. Mounted in the side panel and on the settings page.

import { getSettings, setSettings } from "../core/store.js";
import { TESTER_BUILD } from "../core/build.js";
import { LEADS, REMINDER_TYPES } from "../core/reminders.js";
import { icon, esc } from "./icons.js";

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

const SOURCE_HELP = {
  live: "Reads your courses on learn.uwaterloo.ca with the session signed in on this browser.",
  demo: "Shows made-up courses from the demo. Nothing is read from Learn.",
};

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

function template(s, courses, context) {
  const r = s.reminders;
  const head = LEADS.map((l) => `<th scope="col">${esc(l.label)}</th>`).join("");
  const rows = REMINDER_TYPES.map(
    (t) => `<tr><th scope="row">${esc(t.label)}</th>${LEADS.map((l) => {
      const on = (r.leads[t.id] || []).includes(l.id);
      return `<td><label class="cell"><input class="box" type="checkbox" data-lead="${l.id}" data-type="${t.id}" ${on ? "checked" : ""} aria-label="${esc(`${t.label}, ${l.label.toLowerCase()}`)}"></label></td>`;
    }).join("")}</tr>`
  ).join("");

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
      <p class="set-help">Pick when you hear about each kind of item. Every reminder names the course and the item.</p>
      <table class="matrix">
        <thead><tr><th scope="col">Item type</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">${icon("check", 18)}<span>Reminders stop once Learn shows you submitted something, or once you check it off yourself.</span></p>

      <h3>Courses</h3>
      <p class="set-help">Turn off reminders for a course. Its deadlines still show in the list.</p>
      ${courseList}

      <p class="note">${icon("info", 18)}<span>Notifications only show while Chrome is open. To keep getting them after you close every Chrome window, turn on <strong>Continue running background apps</strong> in Chrome's system settings.</span></p>
    </section>

    <section class="set-section" aria-labelledby="set-look">
      <h2 id="set-look">Appearance</h2>
      <div class="seg" role="radiogroup" aria-labelledby="set-look">
        ${theme("system", "Match system")}${theme("light", "Light")}${theme("dark", "Dark")}
      </div>
    </section>

    <section class="set-section" aria-labelledby="set-data">
      <h2 id="set-data">Your data</h2>
      <p class="note" style="margin-top:6px">${icon("lock", 18)}<span>WATnow reads Learn with the session that's already signed in on this browser, so it never sees your password. Your deadlines and settings stay on this computer. WATnow only sends an anonymous count when you open the panel.</span></p>
      <div style="margin-top:16px" data-delete-area>
        <button class="btn btn-danger btn-sm" data-act="ask-delete">Delete my data</button>
      </div>
      ${context === "panel" ? `<p style="margin:18px 0 0"><button class="link-btn" data-act="open-options">${TESTER_BUILD ? "Get a debug report for the developer" : "Open demo controls and live mode check"}</button></p>` : ""}
    </section>
  </div>`;
}

export async function mountSettings(root, { courses = [], context = "panel", onDeleted } = {}) {
  let settings = await getSettings();
  root.innerHTML = template(settings, courses, context);

  const save = async (fn) => {
    settings = await setSettings(fn);
    chrome.runtime.sendMessage({ type: "settings:changed" }).catch(() => {});
  };

  root.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.matches("input[data-lead]")) {
      const { lead, type } = t.dataset;
      const checked = t.checked;
      await save((s) => {
        const set = new Set(s.reminders.leads[type] || []);
        if (checked) set.add(lead);
        else set.delete(lead);
        s.reminders.leads[type] = LEADS.map((l) => l.id).filter((id) => set.has(id));
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
    const t = e.target.closest("[data-course], [data-act]");
    if (!t) return;
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
