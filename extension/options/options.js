import { getSettings, setSettings } from "../src/core/store.js";
import { applyTheme } from "../src/ui/settings-view.js";
import { DEMO_SCRIPT, COURSES, ITEMS } from "../src/data/fixtures.js";
import { brandMark, esc } from "../src/ui/icons.js";
import { fmtAgo } from "../src/core/dates.js";
import { TESTER_BUILD } from "../src/core/build.js";
import { isArcPage } from "../src/core/browser.js";

const APP = chrome.i18n.getMessage("appName") || "WATnow";
const page = document.getElementById("page");

function itemName(id) {
  const item = ITEMS.find((i) => i.id === id);
  if (!item) return id;
  const course = COURSES.find((c) => c.id === item.course);
  return `${course ? course.code : ""} ${item.title}`.trim();
}

function moveText() {
  const [first, second] = DEMO_SCRIPT.moves;
  if (!first) return "No date changes are set up in fixtures.js.";
  const days = Math.abs(first.shiftDays);
  let text = `${itemName(first.itemId)} moves ${days} ${days === 1 ? "day" : "days"} ${first.shiftDays > 0 ? "later" : "earlier"}. You get a notification and the side panel moves the item to its new spot.`;
  if (second) text += ` Press it again to move ${itemName(second.itemId)}.`;
  return text;
}

function keysHTML(shortcut) {
  if (!shortcut) return `<span>Shortcut not set.</span>`;
  return shortcut
    .split("+")
    .map((k) => `<kbd>${esc(k)}</kbd>`)
    .join("<span>+</span>");
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

const OUTCOME = {
  "signed-out": "Learn said nobody was signed in.",
  "no-tab": "Learn said nobody was signed in, and no Learn tab was open to try instead.",
  unreachable: "WATnow couldn't reach Learn. The network was down or Learn didn't answer.",
  "every-course-failed": "Learn answered, but every course failed to read.",
  error: "The read stopped with an error.",
  "course-failed": "The read stopped with an error.",
};

function debugSummary(report) {
  if (!report) return TESTER_BUILD ? "WATnow hasn't read Learn yet. Open the WATnow side panel while you're signed in to Learn." : "WATnow hasn't read your real Learn account yet. Choose Live from Learn above, then open the side panel.";
  const when = report.finishedAt ? fmtAgo(report.finishedAt, new Date()) : "unfinished";
  const failed = report.failedRequests || 0;
  const counts = report.counts;
  let text = `Last live read: ${when}. `;
  if (report.outcome === "ok" && counts) {
    text += `Found ${plural(counts.items, "deadline", "deadlines")} across ${plural(counts.courses, "course", "courses")}. `;
  } else if (report.outcome) {
    text += `${OUTCOME[report.outcome] || OUTCOME.error} `;
  }
  text += `${plural((report.requests || []).length, "request", "requests")}, ${failed} failed.`;
  return text;
}

async function render() {
  const settings = await getSettings();
  applyTheme(settings.theme);
  document.title = "Report a Bug";
  const { liveDebug } = await chrome.storage.local.get("liveDebug");
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch {
    /* not available */
  }
  const key = (name) => (commands.find((c) => c.name === name) || {}).shortcut || "";

  const demo = [
    { act: "demo:move", cmd: "demo-move-date", title: "Move a due date", body: moveText(), label: "Move a date" },
    {
      act: "demo:reminder",
      cmd: "demo-reminder",
      title: "Send a reminder",
      body: `Sends the reminder for ${itemName(DEMO_SCRIPT.reminder.itemId)}, which closes about two hours after you reset.`,
      label: "Send reminder",
    },
    {
      act: "demo:reset",
      cmd: "demo-reset",
      title: "Reset demo",
      body: "Puts every date and submission back and clears what WATnow has read. Close the side panel first if you want to film the first open.",
      label: "Reset demo",
    },
  ];

  page.innerHTML = `
    <header class="page-head">
      <span class="mark-tile">${brandMark(40)}</span>
      <div>
        <h1>Report a Bug</h1>
      </div>
    </header>

    ${TESTER_BUILD ? "" : `<div class="sheet">
      <section class="set-section" aria-labelledby="demo-h">
        <h2 id="demo-h">Demo controls</h2>
        <p class="set-help">Use these while recording. Each one also has a keyboard shortcut that works anywhere in Chrome, including when the side panel has focus.</p>
        <ul class="demo-list">
          ${demo
            .map(
              (d) => `<li class="demo-row">
                <div>
                  <h3>${esc(d.title)}</h3>
                  <p>${esc(d.body)}</p>
                  <div class="keys">${keysHTML(key(d.cmd))}</div>
                </div>
                <button class="btn ${d.act === "demo:reset" ? "btn-quiet" : "btn-primary"}" data-demo="${d.act}">${esc(d.label)}</button>
                <p class="demo-status" data-status-for="${d.act}" role="status"></p>
              </li>`
            )
            .join("")}
        </ul>
        <p class="set-help" style="margin-top:14px">If a shortcut is missing or another app already uses it, change it on Chrome's shortcuts page.</p>
        <button class="btn btn-quiet btn-sm" data-act="shortcuts">Open shortcut settings</button>
      </section>

      <section class="set-section" aria-labelledby="src-h">
        <h2 id="src-h">Where deadlines come from</h2>
        <div class="radio-list" role="radiogroup" aria-labelledby="src-h">
          <label class="radio"><input type="radio" name="mode" value="demo" ${settings.mode !== "live" ? "checked" : ""}><span><strong>Demo data</strong><span>Made-up courses from fixtures.js, shown on the mock Learn site.</span></span></label>
          <label class="radio"><input type="radio" name="mode" value="live" ${settings.mode === "live" ? "checked" : ""}><span><strong>Live from Learn</strong><span>Reads your courses on learn.uwaterloo.ca with the session signed in on this browser. Open the side panel after switching.</span></span></label>
        </div>
        <label class="field-label" for="base">Mock Learn address</label>
        <div class="field">
          <input class="input" id="base" type="url" value="${esc(settings.learnBase)}" spellcheck="false">
          <button class="btn btn-quiet btn-sm" data-act="save-base">Save address</button>
        </div>
        <p class="status-text" data-base-status role="status"></p>
        <p class="status-text" data-mode-status role="status"></p>
      </section>
    </div>`}

    <div class="sheet">
      <section class="set-section" aria-labelledby="dbg-h">
        <h2 id="dbg-h" class="sr-only">Debug report</h2>
        <p class="set-help">Send a debug report to Eric and he will buy you a coffee. Your Learn info is not in the report (you can check it first by pasting it somewhere and ctrl+f your info).</p>
        <p class="set-help" data-debug-summary>${esc(debugSummary(liveDebug))}</p>
        <div class="row-actions" style="margin-top:12px">
          <button class="btn btn-primary btn-sm" data-act="copy-debug" ${liveDebug ? "" : "disabled"}>Copy debug info</button>
        </div>
        <p class="status-text" data-debug-status role="status"></p>
        <textarea class="input" data-debug-text rows="8" readonly hidden style="width:100%;height:auto;padding:8px 12px;margin-top:8px;font-family:ui-monospace,monospace;font-size:12px"></textarea>
      </section>
    </div>

    <p class="page-foot">Not affiliated with D2L or the University of Waterloo.</p>`;
}

page.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-demo], [data-act]");
  if (!t) return;
  if (t.dataset.demo) {
    const status = page.querySelector(`[data-status-for="${t.dataset.demo}"]`);
    t.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: t.dataset.demo }).catch((err) => ({ ok: false, reason: String(err) }));
    t.disabled = false;
    status.textContent = res && res.ok ? "Done." : (res && res.reason !== "debounced" && res.reason) || "";
    setTimeout(() => (status.textContent = ""), 5000);
    return;
  }
  if (t.dataset.act === "shortcuts") chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  if (t.dataset.act === "copy-debug") {
    const status = page.querySelector("[data-debug-status]");
    const { liveDebug } = await chrome.storage.local.get("liveDebug");
    if (!liveDebug) return;
    const text = JSON.stringify(liveDebug, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied the report. Paste it into your message to the developer.";
    } catch {
      const box = page.querySelector("[data-debug-text]");
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
      status.textContent = "Copying didn't work. The report is selected below, so press Ctrl+C to copy it.";
    }
  }
  if (t.dataset.act === "save-base") {
    const input = page.querySelector("#base");
    const status = page.querySelector("[data-base-status]");
    let value = input.value.trim().replace(/\/+$/, "");
    try {
      const u = new URL(value);
      value = u.origin;
    } catch {
      status.textContent = "That address doesn't look right. Try http://localhost:8080.";
      return;
    }
    await setSettings({ learnBase: value });
    input.value = value;
    status.textContent = "Saved. Item links now open on this address.";
  }
});

page.addEventListener("change", async (e) => {
  const t = e.target;
  if (!t.matches('input[name="mode"]')) return;
  const mode = t.value === "live" ? "live" : "demo";
  await setSettings({ mode });
  chrome.runtime.sendMessage({ type: "settings:changed" }).catch(() => {});
  const status = page.querySelector("[data-mode-status]");
  if (status) status.textContent = mode === "live" ? "Switched to Live from Learn. Open the side panel to read your courses." : "Switched to demo data.";
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.liveDebug) {
    const summary = page.querySelector("[data-debug-summary]");
    if (summary) summary.textContent = debugSummary(changes.liveDebug.newValue);
    const btn = page.querySelector('[data-act="copy-debug"]');
    if (btn) btn.disabled = !changes.liveDebug.newValue;
  }
  if (area === "local" && changes.settings && changes.settings.newValue) applyTheme(changes.settings.newValue.theme);
});

render();

isArcPage(document).then((arc) => arc && chrome.runtime.sendMessage({ type: "env:arc" }).catch(() => {}));
