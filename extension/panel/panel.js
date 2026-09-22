import { getState, getSettings, getFilter, setFilter, emptyState } from "../src/core/store.js";
import { buildModel } from "../src/core/model.js";
import { fmtDate, fmtTime, sameDay } from "../src/core/dates.js";
import { icon, brandMark, esc, CATEGORY_ICON } from "../src/ui/icons.js";
import { mountSettings, applyTheme } from "../src/ui/settings-view.js";
import { liveBase } from "../src/data/live-source.js";
import { TESTER_BUILD } from "../src/core/build.js";
import { pingPanelOpen } from "../src/core/usage.js";

const APP = chrome.i18n.getMessage("appName") || "WATnow";
const PREVIEW = new URLSearchParams(location.search).get("preview");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

const bar = document.getElementById("bar");
const app = document.getElementById("app");
const announcer = document.getElementById("announce");

let state = emptyState();
let settings = null;
let filter = "all";
let view = "";
let lastSeq = 0;
let sawRunning = false;
let advanceTimer = null;
let earlierOpen = false;
let listScroll = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }).catch(() => null);
const reduced = () => reduceMotion.matches;

let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error(e));
  return queue;
}

function announce(text) {
  announcer.textContent = "";
  setTimeout(() => (announcer.textContent = text), 40);
}

/* ------------------------------------------------------------------ */
/* Top bar                                                             */
/* ------------------------------------------------------------------ */

function renderBar() {
  if (view === "settings") {
    bar.innerHTML = `<button class="icon-btn" data-act="back" aria-label="Back to deadlines">${icon("back")}</button><h1 class="bar-title">Settings</h1><span class="spacer"></span>`;
    return;
  }
  const scan = state.scan.status;
  let status = "";
  if (PREVIEW) status = "";
  else if (scan === "running") status = `<span class="bar-status">Reading Learn</span>`;
  else if (state.syncing) status = `<span class="bar-status">Checking Learn</span>`;
  const busy = scan === "running" || state.syncing;
  const refresh =
    PREVIEW || (scan !== "done" && !busy)
      ? ""
      : `<button class="icon-btn" data-act="refresh" aria-label="${busy ? "Reading Learn" : "Check Learn for changes"}" ${busy ? "disabled" : ""}>${icon("refresh", 20, busy ? "spin" : "")}</button>`;
  bar.innerHTML = `
    <div class="brand"><span class="mark-tile">${brandMark(24)}</span><span class="brand-name">${esc(APP)}</span></div>
    <span class="spacer"></span>
    ${status}
    ${refresh}
    <button class="icon-btn" data-act="settings" aria-label="Reminders and settings">${icon("gear")}</button>`;
}

window.addEventListener("scroll", () => bar.classList.toggle("is-scrolled", window.scrollY > 4), { passive: true });

/* ------------------------------------------------------------------ */
/* First scan                                                          */
/* ------------------------------------------------------------------ */

const SKELETON_WIDTHS = [46, 60, 38, 64, 52];

function scanCopy() {
  const done = state.scan.status === "done";
  const total = state.items.length;
  const handed = state.items.filter((i) => i.status !== "open").length;
  const courses = state.courses.length;
  return done
    ? { title: "Done reading Learn", sub: "Opening your deadlines." }
    : { title: "Reading your courses on Learn", sub: "WATnow uses the Learn session that's already signed in on this browser." };
}

function scanRowState(p) {
  if (p.status === "done") return `${icon("check", 16)}${p.found} ${p.found === 1 ? "deadline" : "deadlines"}`;
  if (p.status === "reading") return "Reading";
  if (p.status === "error") return "Couldn't read";
  return "Waiting";
}

function renderScan() {
  const sc = state.scan;
  let root = app.querySelector(".scan");
  const copy = scanCopy();

  if (!root) {
    app.innerHTML = `
      <section class="scan" aria-busy="true">
        <div class="scan-card">
          <h1 class="scan-h"></h1>
          <p class="scan-sub"></p>
          <ol class="scan-list"></ol>
        </div>
        <p class="privacy">${icon("lock", 18)}<span>WATnow never sees your Learn password. What it reads stays on this computer.</span></p>
      </section>`;
    root = app.querySelector(".scan");
    root.querySelector(".scan-h").textContent = copy.title;
    root.querySelector(".scan-sub").textContent = copy.sub;
  }

  const h = root.querySelector(".scan-h");
  if (h.textContent !== copy.title) {
    h.textContent = copy.title;
    root.querySelector(".scan-sub").textContent = copy.sub;
    if (!reduced()) {
      for (const el of [h, root.querySelector(".scan-sub")]) {
        el.classList.remove("swap");
        void el.offsetWidth;
        el.classList.add("swap");
      }
    }
    announce(copy.title);
  }

  const list = root.querySelector(".scan-list");
  if (!sc.courses.length) {
    if (!list.querySelector(".is-skeleton")) {
      list.innerHTML = SKELETON_WIDTHS.map(
        (w) => `<li class="scan-row is-skeleton"><span class="sk sk-chip"></span><span class="sk" style="width:${w}%"></span></li>`
      ).join("");
    }
  } else {
    if (list.children.length !== sc.courses.length || list.querySelector(".is-skeleton")) {
      list.innerHTML = sc.courses
        .map((p) => {
          const c = state.courses.find((x) => x.id === p.courseId) || { code: "", name: "", color: "mint" };
          return `<li class="scan-row hl-${c.color}" data-course="${c.id}" data-status="waiting"><span class="scan-fill" aria-hidden="true"></span><span class="chip">${esc(c.code)}</span>${c.name ? `<span class="scan-name">${esc(c.name)}</span>` : ""}<span class="scan-state">Waiting</span></li>`;
        })
        .join("");
    }
    sc.courses.forEach((p, i) => {
      const row = list.children[i];
      if (row.dataset.status === p.status) return;
      row.dataset.status = p.status;
      row.querySelector(".scan-state").innerHTML = scanRowState(p);
      const fill = row.querySelector(".scan-fill");
      if (reduced()) {
        fill.style.transform = p.status === "done" ? "scaleX(1)" : "scaleX(0)";
        return;
      }
      if (p.status === "reading") {
        fill.style.transition = "transform 900ms cubic-bezier(0.25, 0.7, 0.3, 1)";
        requestAnimationFrame(() => (fill.style.transform = "scaleX(0.8)"));
      } else if (p.status === "done") {
        fill.style.transition = "transform 260ms cubic-bezier(0.16, 1, 0.3, 1)";
        requestAnimationFrame(() => (fill.style.transform = "scaleX(1)"));
      }
    });
  }

  if (sc.status === "done") root.setAttribute("aria-busy", "false");
}

/* ------------------------------------------------------------------ */
/* Deadline list                                                       */
/* ------------------------------------------------------------------ */

function rowHTML(r) {
  const done = r.status !== "open";
  const name = `${r.code} ${r.title}`;
  const checkLabel =
    r.status === "submitted" ? `${name} is submitted on Learn` : r.status === "done" ? `${name} is checked off. Select to undo.` : `Check off ${name}`;
  const topIcon = r.tone === "overdue" ? icon("alert", 16) : r.tone === "soon" ? icon("clock", 16) : "";
  const moved = r.movedFrom
    ? `<span class="moved">${icon("arrow", 16)}<span>Moved from <span class="was">${esc(r.movedFrom)}</span></span></span>`
    : "";
  return `
  <li class="row tone-${r.tone} hl-${r.color}${r.movedFrom ? " is-moved" : ""}" data-id="${esc(r.id)}" data-flip="r-${esc(r.id)}">
    <button class="check" data-act="toggle" data-id="${esc(r.id)}" aria-pressed="${done}" ${r.status === "submitted" ? 'aria-disabled="true"' : ""} aria-label="${esc(checkLabel)}">
      <span class="check-ring">${icon("check", 14, "check-mark")}</span>
    </button>
    <button class="row-open" data-act="open" data-id="${esc(r.id)}">
      <span class="row-main">
        <span class="meta"><span class="chip">${esc(r.code)}</span><span class="type">${icon(CATEGORY_ICON[r.category] || "doc", 16)}${esc(r.type)}</span></span>
        <span class="title">${esc(r.title)}</span>
        ${moved}
      </span>
      <span class="due">
        ${r.opensNote ? `<span class="opens">${icon("lock", 14)}<span>Opens ${esc(r.opensNote)}</span></span>` : ""}
        <span class="due-top">${topIcon}<span>${esc(r.top)}</span></span>
        ${r.dateNote ? `<span class="due-bottom">${esc(r.dateNote)}</span>` : ""}
        <span class="due-bottom"><span class="due-time${r.timeOdd ? " is-odd" : ""}">${esc(r.time)}</span></span>
      </span>
    </button>
  </li>`;
}

function groupHTML(g) {
  const head = `<span class="gh-title">${esc(g.label)}</span>${g.subtitle ? `<span class="gh-sub">${esc(g.subtitle)}</span>` : ""}`;
  const rows = g.rows.map(rowHTML).join("");
  if (g.id === "earlier") {
    return `<details class="group" data-group="earlier" ${earlierOpen ? "open" : ""}>
      <summary class="group-head" data-flip="g-earlier">${icon("chev", 16, "gh-chev")}${head}</summary>
      <ul class="rows">${rows}</ul></details>`;
  }
  return `<section class="group" data-group="${g.id}"><h2 class="group-head" data-flip="g-${g.id}">${head}</h2><ul class="rows">${rows}</ul></section>`;
}

/** Shown above the list when the last check couldn't read Learn. */
function staleHTML(now) {
  const st = state.stale;
  if (!st || !state.lastSyncAt) return "";
  const at = new Date(state.lastSyncAt);
  const when = sameDay(at, now) ? `at ${fmtTime(at)}` : `on ${fmtDate(at)} at ${fmtTime(at)}`;
  const lead = st.kind === "signed-out" ? "Learn signed you out." : "Couldn't reach Learn.";
  const action = st.kind === "unreachable" ? "" : `<button class="link-btn stale-btn" data-act="open-learn">Open Learn</button>`;
  return `<div class="stale" role="status" data-flip="stale">${icon("info", 16)}<p>${esc(`${lead} Showing what ${APP} read ${when}.`)}</p>${action}</div>`;
}

function renderList() {
  const now = new Date();
  const m = buildModel(state, now, filter);
  if (filter !== "all" && !m.filterCourse) filter = "all";

  const chips = [
    `<button class="fchip" data-filter="all" aria-pressed="${filter === "all"}"><span>All</span><span class="fcount">${m.total}</span></button>`,
    ...m.courses.map(
      (c) =>
        `<button class="fchip hl-${c.color}" data-filter="${esc(c.id)}" aria-pressed="${filter === c.id}" aria-label="${esc(`${c.code}, ${m.counts[c.id]} deadlines`)}"><span class="swatch" aria-hidden="true"></span><span>${esc(c.code)}</span><span class="fcount">${m.counts[c.id]}</span></button>`
    ),
  ].join("");

  const empty =
    m.filterCourse && m.openInFilter === 0
      ? `<div class="empty" data-flip="empty">${icon("check", 22)}<h2>Nothing to hand in for ${esc(m.filterCourse.code)}.</h2><p>${
          m.groups.some((g) => g.id === "earlier") ? "Anything you already handed in is under Handed in earlier." : "New items show up here when your prof posts them on Learn."
        }</p></div>`
      : "";

  app.innerHTML = `
    <div class="list-view">
      ${staleHTML(now)}
      <section class="verdict" data-flip="verdict">
        <h1 class="verdict-h"><span>${esc(m.verdict.line1)}</span>${m.verdict.sleepy ? icon("zzz", 22) : ""}</h1>
        ${m.verdict.line2 ? `<p class="verdict-sub">${esc(m.verdict.line2)}</p>` : ""}
        ${m.verdict.detail ? `<p class="late-line">${icon("alert", 18)}<span>${esc(m.verdict.detail)}</span></p>` : ""}
      </section>
      <div class="filters" role="group" aria-label="Show deadlines for" data-flip="filters">${chips}</div>
      ${empty}
      <div class="groups">${m.groups.map(groupHTML).join("")}</div>
      <footer class="foot" data-flip="foot">
        <p>Not affiliated with D2L or the University of Waterloo.</p>
      </footer>
    </div>`;
}

function rowEl(id) {
  return app.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
}

function snapshot() {
  const map = new Map();
  for (const el of app.querySelectorAll("[data-flip]")) {
    const r = el.getBoundingClientRect();
    if (r.height) map.set(el.dataset.flip, r.top + window.scrollY);
  }
  return map;
}

function playFlip(before, { skip, duration = 600 } = {}) {
  const anims = [];
  for (const el of app.querySelectorAll("[data-flip]")) {
    const key = el.dataset.flip;
    if (key === skip) continue;
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    const top = r.top + window.scrollY;
    if (before.has(key)) {
      const dy = before.get(key) - top;
      if (Math.abs(dy) > 0.5) {
        anims.push(el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration, easing: EASE_IN_OUT }));
      }
    } else {
      anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay: duration * 0.5, easing: "ease-out", fill: "backwards" }));
    }
  }
  return anims;
}

function easeInOut(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function animateScroll(to, duration) {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const target = Math.max(0, Math.min(max, to));
  const from = window.scrollY;
  if (!duration || reduced() || Math.abs(target - from) < 2) {
    window.scrollTo(0, target);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / duration);
      window.scrollTo(0, from + (target - from) * easeInOut(p));
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

function ensureVisible(el, ratio = 0.38, duration = 460) {
  const r = el.getBoundingClientRect();
  const topSafe = bar.offsetHeight + 12;
  if (r.top >= topSafe && r.bottom <= window.innerHeight - 24) return Promise.resolve();
  return animateScroll(window.scrollY + r.top - window.innerHeight * ratio, duration);
}

function flashEnter() {
  if (reduced()) return;
  const items = [...app.querySelectorAll(".verdict, .filters, .group-head, .row")].slice(0, 16);
  items.forEach((el, i) => {
    el.classList.add("enter");
    el.style.animationDelay = `${Math.min(i * 30, 420)}ms`;
    el.addEventListener("animationend", () => {
      el.classList.remove("enter");
      el.style.animationDelay = "";
    }, { once: true });
  });
}

/* The moment the video is built around: a prof moves a due date. */
async function animateMove(itemId) {
  const item = state.items.find((i) => i.id === itemId);
  const course = item && state.courses.find((c) => c.id === item.courseId);
  const row = rowEl(itemId);
  if (!row || reduced()) {
    renderList();
    const r = rowEl(itemId);
    if (r) await ensureVisible(r, 0.4, 0);
    if (item && course) announce(`${course.code} ${item.title} moved.`);
    return;
  }

  await ensureVisible(row, 0.36);
  row.classList.add("is-striking");
  await sleep(720);

  const before = snapshot();
  renderList();
  const moving = rowEl(itemId);
  if (!moving) return;
  moving.classList.add("is-travelling");

  const rect = moving.getBoundingClientRect();
  const dy = before.get(`r-${itemId}`) - (rect.top + window.scrollY);
  const duration = Math.min(1050, Math.max(700, 520 + Math.abs(dy) * 0.45));
  playFlip(before, { skip: `r-${itemId}`, duration: duration * 0.85 });
  const travel = moving.animate(
    [
      { transform: `translateY(${dy}px) scale(1)` },
      { transform: `translateY(${dy * 0.9}px) scale(1.03)`, offset: 0.2 },
      { transform: `translateY(${dy * 0.08}px) scale(1.03)`, offset: 0.82 },
      { transform: "translateY(0) scale(1)" },
    ],
    { duration, easing: EASE_IN_OUT }
  );
  animateScroll(window.scrollY + rect.top - window.innerHeight * 0.42, duration);
  await travel.finished.catch(() => {});

  moving.classList.remove("is-travelling");
  moving.classList.add("is-landing");
  if (item && course) announce(`${course.code} ${item.title} moved to ${moving.querySelector(".due-top").textContent.trim()}.`);
  await sleep(1000);
  moving.classList.remove("is-landing");
}

async function animateStatus(itemId, type) {
  const row = rowEl(itemId);
  if (row) await ensureVisible(row, 0.4);
  renderList();
  const r = rowEl(itemId);
  if (!r || reduced()) return;
  if (type === "submitted" || type === "marked") {
    r.classList.add("is-checking");
    await sleep(700);
    r.classList.remove("is-checking");
  }
}

async function animatePing(itemId) {
  renderList();
  const row = rowEl(itemId);
  if (!row) return;
  await ensureVisible(row, 0.38);
  if (reduced()) return;
  row.classList.add("is-pinged");
  await sleep(1650);
  row.classList.remove("is-pinged");
}

/* ------------------------------------------------------------------ */
/* Other whole-panel states                                            */
/* ------------------------------------------------------------------ */

function renderStateView(kind) {
  const views = {
    "signed-out": {
      mark: icon("lock", 24),
      title: "Sign in to Learn first",
      body: "WATnow reads Learn through the session in this browser. Open Learn and sign in. Your deadlines show up here once a Learn page loads. If they don't, select Try again.",
      action: `<div class="row-actions"><button class="btn btn-primary" data-act="open-learn">Open Learn</button><button class="btn btn-quiet" data-act="retry">Try again</button></div>`,
    },
    offline: {
      mark: icon("alert", 24),
      title: "Couldn't reach Learn",
      body: "Check that this computer is online, then try again.",
      action: `<button class="btn btn-primary" data-act="retry">Try again</button>`,
    },
    error: {
      mark: icon("alert", 24),
      late: true,
      title: "Couldn't read Learn",
      body: "Learn didn't respond. Check that you're still signed in, then try again.",
      action: `<button class="btn btn-primary" data-act="retry">Try again</button>`,
    },
    "no-courses": {
      mark: icon("info", 24),
      title: "No courses on Learn this term",
      body: "WATnow didn't find any courses for this term in your Learn account. If Learn lists your courses, select Try again.",
      action: `<button class="btn btn-primary" data-act="retry">Try again</button>`,
    },
    empty: {
      mark: icon("check", 24),
      title: "No deadlines on Learn yet",
      body: "Your courses are there, but none of them have dated items yet. When a prof posts something with a due date, it shows up here.",
      action: "",
    },
    deleted: {
      mark: icon("check", 24),
      title: "Your data is deleted",
      body: "WATnow removed your deadlines and settings from this computer. It reads Learn again only when you ask it to.",
      action: `<button class="btn btn-primary" data-act="retry">Read Learn again</button>`,
    },
  };
  const v = views[kind];
  app.innerHTML = `<section class="state"><div class="state-mark${v.late ? " is-late" : ""}">${v.mark}</div><h1>${esc(v.title)}</h1><p>${esc(v.body)}</p>${v.action}</section>`;
}

function errorKind() {
  if (state.errorKind === "signed-out" || state.errorKind === "offline") return state.errorKind;
  return "error";
}

/** A finished read with nothing to list gets a whole-panel state instead of an empty list. */
function doneKind() {
  if (!state.courses.length) return "no-courses";
  if (!state.items.length) return "empty";
  return "list";
}

/* ------------------------------------------------------------------ */
/* Scan to dashboard sweep                                             */
/* ------------------------------------------------------------------ */

// Two yellow lines run in from the top and the bottom edges, wiping the scan
// away to the panel background. They meet in the middle, the dashboard is
// built behind them, then they run back out and uncover it.
const SWEEP_IN = 340;
const SWEEP_HOLD = 90;
const SWEEP_OUT = 420;

async function sweepTo(render) {
  if (reduced()) {
    render();
    return;
  }
  const el = document.createElement("div");
  el.className = "sweep";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<div class="sweep-half sweep-top"><span class="sweep-line"></span></div><div class="sweep-half sweep-bottom"><span class="sweep-line"></span></div>`;
  document.body.appendChild(el);
  const halves = [...el.querySelectorAll(".sweep-half")];
  const run = (from, to, duration, easing) =>
    Promise.all(
      halves.map((h) => h.animate([{ height: from }, { height: to }], { duration, easing, fill: "forwards" }).finished.catch(() => {}))
    );
  try {
    await run("0px", "50vh", SWEEP_IN, EASE_IN_OUT);
    render();
    await sleep(SWEEP_HOLD);
    await run("50vh", "0px", SWEEP_OUT, "cubic-bezier(0.16, 1, 0.3, 1)");
  } finally {
    el.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

function setView(next) {
  if (view === "list" && next !== "list") listScroll = window.scrollY;
  view = next;
  renderBar();
}

function showList({ entrance = false } = {}) {
  clearTimeout(advanceTimer);
  const kind = doneKind();
  if (kind !== "list") {
    setView(kind);
    renderStateView(kind);
    return;
  }
  setView("list");
  renderList();
  if (entrance) {
    window.scrollTo(0, 0);
    flashEnter();
  }
}

function showScan() {
  if (view !== "scan") {
    setView("scan");
    app.innerHTML = "";
  }
  renderScan();
}

async function openSettings() {
  setView("settings");
  window.scrollTo(0, 0);
  await mountSettings(app, {
    courses: state.courses,
    context: "panel",
  });
  bar.querySelector('[data-act="back"]')?.focus();
}

function closeSettings() {
  route();
  if (view === "list") window.scrollTo(0, listScroll);
  if (state.scan.status === "idle" && !state.deletedAt) send("panel:opened");
}

function route() {
  if (PREVIEW) {
    setView("state");
    renderStateView(PREVIEW);
    return;
  }
  const s = state.scan.status;
  if (state.deletedAt && s === "idle") {
    setView("deleted");
    renderStateView("deleted");
  } else if (s === "error") {
    setView(errorKind());
    renderStateView(errorKind());
  } else if (s === "done") {
    showList();
  } else {
    sawRunning = sawRunning || s === "running" || s === "idle";
    showScan();
  }
}

function onState(next) {
  const prev = state;
  state = next;
  if (view === "settings") {
    if (next.deletedAt && next.scan.status === "idle") {
      setView("deleted");
      renderStateView("deleted");
    }
    return;
  }
  renderBar();
  const s = next.scan.status;

  if (s === "idle") {
    if (next.deletedAt) {
      setView("deleted");
      renderStateView("deleted");
      return;
    }
    sawRunning = true;
    lastSeq = next.seq;
    showScan();
    send("panel:opened");
    return;
  }
  if (s === "running") {
    sawRunning = true;
    lastSeq = next.seq;
    showScan();
    return;
  }
  if (s === "error") {
    setView(errorKind());
    renderStateView(errorKind());
    return;
  }

  // done
  if (view !== "list" && view !== "state") {
    lastSeq = next.seq;
    if (sawRunning && view === "scan") {
      renderScan();
      if (prev.scan.status !== "done") {
        clearTimeout(advanceTimer);
        // Long enough for the last course row to finish filling in, no longer.
        advanceTimer = setTimeout(() => enqueue(() => sweepTo(() => showList({ entrance: true }))), 1000);
      }
    } else {
      showList();
    }
    return;
  }

  const ev = next.lastEvent;
  if (ev && ev.seq > lastSeq) {
    lastSeq = ev.seq;
    if (ev.type === "moved") return enqueue(() => animateMove(ev.itemId));
    if (ev.type === "submitted" || ev.type === "marked" || ev.type === "unmarked") return enqueue(() => animateStatus(ev.itemId, ev.type));
    if (ev.type === "reminded") return enqueue(() => animatePing(ev.itemId));
  }
  enqueue(() => {
    if (view === "list") renderList();
  });
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

app.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (chip) {
    filter = chip.dataset.filter;
    setFilter(filter);
    enqueue(() => {
      renderList();
      if (!reduced()) app.querySelector(".groups")?.animate([{ opacity: 0.001 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    });
    return;
  }
  const t = e.target.closest("[data-act]");
  if (!t) return;
  switch (t.dataset.act) {
    case "toggle":
      if (t.getAttribute("aria-disabled") === "true") return;
      send("item:toggle-done", { itemId: t.dataset.id });
      break;
    case "open":
      send("item:open", { itemId: t.dataset.id });
      break;
    case "retry":
      send("panel:rescan");
      break;
    case "open-learn":
      chrome.tabs.create({
        url: settings && settings.mode === "live" ? `${liveBase(settings)}/d2l/home` : `${(settings && settings.learnBase) || "https://learn.uwaterloo.ca"}/d2l/home/`,
      });
      break;
  }
});

app.addEventListener("toggle", (e) => {
  if (e.target.matches('details[data-group="earlier"]')) earlierOpen = e.target.open;
}, true);

bar.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  if (t.dataset.act === "refresh") send("panel:refresh");
  if (t.dataset.act === "settings") (view === "settings" ? closeSettings() : openSettings());
  if (t.dataset.act === "back") closeSettings();
});

// Hidden demo shortcuts. Chrome's own commands (manifest "commands") fire too;
// the background ignores a duplicate within 700 ms.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && view === "settings") {
    closeSettings();
    return;
  }
  if (TESTER_BUILD || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
  const map = { KeyM: "demo:move", KeyK: "demo:reminder", Digit0: "demo:reset" };
  const type = map[e.code];
  if (!type) return;
  e.preventDefault();
  send(type);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.state) onState(changes.state.newValue || emptyState());
  if (area === "local" && changes.settings && changes.settings.newValue) {
    settings = changes.settings.newValue;
    applyTheme(settings.theme);
  }
});

setInterval(() => {
  if (view === "list" || view === "scan") renderBar();
}, 30000);

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

(async function init() {
  settings = await getSettings();
  applyTheme(settings.theme);
  document.title = APP;
  filter = await getFilter();
  state = await getState();
  lastSeq = state.seq || 0;
  await document.fonts.ready.catch(() => {});
  route();
  if (!PREVIEW) pingPanelOpen();
  if (!PREVIEW && (state.scan.status === "idle" || state.scan.status === "running") && !state.deletedAt) send("panel:opened");
  // The last check couldn't read Learn: try again now that the student is looking.
  if (!PREVIEW && state.scan.status === "done" && state.stale) send("panel:check");
})();

window.addEventListener("online", () => {
  if (PREVIEW) return;
  if ((state.scan.status === "done" && state.stale) || (state.scan.status === "error" && state.errorKind === "offline")) send("panel:check");
});
