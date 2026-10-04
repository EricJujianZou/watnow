import { getState, getSettings, setSettings, getFilter, setFilter, emptyState } from "../src/core/store.js";
import { buildModel } from "../src/core/model.js";
import { fmtDate, fmtTime, sameDay } from "../src/core/dates.js";
import { icon, brandMark, esc, CATEGORY_ICON } from "../src/ui/icons.js";
import { mountSettings, applyTheme } from "../src/ui/settings-view.js";
import { liveBase } from "../src/data/live-source.js";
import { SCHOOLS, schoolById, currentSchool, systemName, homeUrl } from "../src/core/schools.js";
import { TESTER_BUILD } from "../src/core/build.js";
import { pingPanelOpen } from "../src/core/usage.js";
import { crowdmarkAllowed, crowdmarkBase } from "../src/data/crowdmark-source.js";

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
/** Whether Chrome gave WATnow access to Crowdmark. Checked on open and whenever the permission changes. */
let cmAllowed = false;
/** Set from the Connect click until Crowdmark reads or the student gives up, so the button can say Connecting. */
let cmConnectingUntil = 0;
const CM_CONNECT_WAIT_MS = 3 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }).catch(() => null);
const reduced = () => reduceMotion.matches;

let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error(e));
  return queue;
}

/** What students call the site WATnow reads: "Learn", "onQ", "OWL". The demo is always Learn. */
function lms() {
  return settings && settings.mode === "live" ? systemName(settings) : "Learn";
}

/** LIVE mode with no school picked: the panel asks for one before it reads anything. */
function needsSchool() {
  return !PREVIEW && !!settings && settings.mode === "live" && !currentSchool(settings);
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
  else if (scan === "running") status = `<span class="bar-status">Reading ${lms()}</span>`;
  else if (state.syncing) status = `<span class="bar-status">Checking ${lms()}</span>`;
  const busy = scan === "running" || state.syncing;
  const refresh =
    PREVIEW || (scan !== "done" && !busy)
      ? ""
      : `<button class="icon-btn" data-act="refresh" aria-label="${busy ? `Reading ${lms()}` : `Check ${lms()} for changes`}" ${busy ? "disabled" : ""}>${icon("refresh", 20, busy ? "spin" : "")}</button>`;
  // The bar can't fit both the Crowdmark button and the status pill at side panel widths; the spinning refresh still shows a check is running.
  const cmBtn = cmButtonHTML(scan);
  if (cmBtn) status = "";
  bar.innerHTML = `
    <div class="brand"><span class="mark-tile">${brandMark(24)}</span><span class="brand-name">${esc(APP)}</span></div>
    <span class="spacer"></span>
    ${status}
    ${cmBtn}
    ${refresh}
    <button class="icon-btn" data-act="settings" aria-label="Reminders and settings">${icon("gear")}</button>`;
}

/** True when Crowdmark is connected but its last read failed. */
function cmDown() {
  const cm = state.crowdmark;
  return cmAllowed && !cmConnecting() && !!cm && (cm.status === "signed-out" || cm.status === "unreachable");
}

function cmConnecting() {
  if (!cmConnectingUntil) return false;
  if (Date.now() > cmConnectingUntil || (state.crowdmark && state.crowdmark.status === "ok")) {
    cmConnectingUntil = 0;
    return false;
  }
  return true;
}

/** Left of refresh: yellow Connect until Crowdmark reads, then a quiet Connected label. Waterloo only for now. */
function cmButtonHTML(scan) {
  if (PREVIEW || scan !== "done" || !settings || settings.mode !== "live" || settings.school !== "uwaterloo") return "";
  if (cmConnecting()) return `<span class="btn btn-primary btn-sm cm-btn is-connecting" role="status">${icon("refresh", 16, "spin")}Connecting…</span>`;
  if (cmAllowed && !cmDown()) return `<span class="btn btn-quiet btn-sm cm-btn is-connected">Crowdmark Connected</span>`;
  return `<button class="btn btn-primary btn-sm cm-btn" data-act="cm-connect">Connect Crowdmark</button>`;
}

async function refreshCm() {
  cmAllowed = await crowdmarkAllowed(settings);
  renderBar();
}

/** Asks Chrome for Crowdmark access, then reads. If access is already there, the student needs to sign in again. */
async function connectCrowdmark() {
  const base = crowdmarkBase(settings);
  if (!cmAllowed) {
    const ok = await chrome.permissions.request({ origins: [`${base}/*`] }).catch(() => false);
    if (!ok) return;
    cmAllowed = true;
  }
  cmConnectingUntil = Date.now() + CM_CONNECT_WAIT_MS;
  renderBar();
  const res = await chrome.runtime.sendMessage({ type: "crowdmark:connect" }).catch(() => null);
  const status = res && res.status;
  // Not signed in yet: open the sign-in page and keep saying Connecting. The
  // background reads Crowdmark again as soon as the sign-in finishes.
  if (status === "signed-out") chrome.tabs.create({ url: `${base}/sign-in/waterloo` });
  else if (status !== "ok") cmConnectingUntil = 0;
  renderBar();
  if (view === "list") renderList();
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
    ? { title: `Done reading ${lms()}`, sub: "Opening your deadlines." }
    : { title: `Reading your courses on ${lms()}`, sub: `WATnow uses the ${lms()} session that's already signed in on this browser.` };
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
        <p class="privacy">${icon("lock", 18)}<span>WATnow never sees your ${esc(lms())} password. What it reads stays on this computer.</span></p>
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
          const c =
            p.courseId === "crowdmark"
              ? { id: "crowdmark", code: "Crowdmark", name: "", color: "mint" }
              : state.courses.find((x) => x.id === p.courseId) || { code: "", name: "", color: "mint" };
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
    r.status === "submitted" ? `${name} is submitted on ${lms()}` : r.status === "done" ? `${name} is checked off. Select to undo.` : `Check off ${name}`;
  const topIcon = r.tone === "overdue" ? icon("alert", 16) : r.tone === "soon" ? icon("clock", 16) : "";
  const moved = r.movedFrom
    ? `<span class="moved">${icon("arrow", 16)}<span>Moved from <span class="was">${esc(r.movedFrom)}</span></span></span>`
    : "";
  return `
  <li class="row tone-${r.tone} hl-${r.color}${r.movedFrom ? " is-moved" : ""}${r.handIn === "missing" ? " is-unsent" : ""}" data-id="${esc(r.id)}" data-flip="r-${esc(r.id)}">
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
    ${handInHTML(r)}
  </li>`;
}

/** Under a checked-off row: asking the site, or the site shows nothing handed in. */
function handInHTML(r) {
  const site = r.kind === "crowdmark" ? "Crowdmark" : lms();
  if (r.handIn === "checking") {
    return `<p class="handin is-checking" role="status"><span class="handin-bar" aria-hidden="true"></span><span>Checking ${esc(site)} for your submission</span></p>`;
  }
  if (r.handIn !== "missing") return "";
  const where = r.kind === "crowdmark" ? "Crowdmark" : r.kind === "quiz" ? "quiz" : "dropbox";
  return `<p class="handin is-missing" role="status">${icon("alert", 16)}<span>${esc(site)} doesn't show a submission for this yet.</span>
    <button class="handin-open" data-act="open" data-id="${esc(r.id)}">Open ${where}</button></p>`;
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
  const cm = cmDown() ? state.crowdmark : null;
  const lastAt = st ? state.lastSyncAt : cm && (cm.okAt || state.lastSyncAt);
  if ((!st && !cm) || !lastAt) return "";
  const at = new Date(lastAt);
  const when = sameDay(at, now) ? `at ${fmtTime(at)}` : `on ${fmtDate(at)} at ${fmtTime(at)}`;
  let lead;
  if (st && cm && st.kind === cm.status) lead = st.kind === "signed-out" ? `${lms()} and Crowdmark signed you out.` : `Couldn't reach ${lms()} or Crowdmark.`;
  else {
    const learnLead = !st ? "" : st.kind === "signed-out" ? `${lms()} signed you out.` : `Couldn't reach ${lms()}.`;
    const cmLead = !cm ? "" : cm.status === "signed-out" ? "Crowdmark signed you out." : "Couldn't reach Crowdmark.";
    lead = [learnLead, cmLead].filter(Boolean).join(" ");
  }
  const tail = st ? `Showing what ${APP} read ${when}.` : `Crowdmark deadlines are from ${when}.`;
  const action = !st || st.kind === "unreachable" ? "" : `<button class="link-btn stale-btn" data-act="open-learn">Open ${lms()}</button>`;
  return `<div class="stale" role="status" data-flip="stale">${icon("info", 16)}<p>${esc(`${lead} ${tail}`)}</p>${action}</div>`;
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
          m.groups.some((g) => g.id === "earlier") ? "Anything you already handed in is under Handed in earlier." : `New items show up here when your prof posts them on ${lms()}.`
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
/* School picker                                                       */
/* ------------------------------------------------------------------ */

// Waterloo first, since most students are there, then the rest by name.
const PICK_ORDER = [SCHOOLS[0], ...SCHOOLS.slice(1).sort((a, b) => a.name.localeCompare(b.name))];

function pickButtonLabel(school) {
  return school ? `Open ${school.system}` : "Open your course site";
}

function renderSchoolPicker() {
  const options = PICK_ORDER.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  app.innerHTML = `
    <div class="pick">
      <section class="state">
        <div class="state-mark">${icon("cap", 24)}</div>
        <h1>Choose your school</h1>
        <p>WATnow reads your deadlines from your school's course site, using the session that's already signed in on this browser.</p>
        <label class="pick-label" for="school-select">School</label>
        <select class="select pick-select" id="school-select">
          <option value="" disabled selected>Select your school</option>
          ${options}
        </select>
        <button class="btn btn-primary" data-act="pick-school" disabled>${esc(pickButtonLabel(null))}</button>
        <p class="status-text pick-status" role="status"></p>
        <p class="pick-note">Don't see your school? WATnow works with schools that use D2L Brightspace. Message Eric on Instagram @sleppyeric and he'll add yours.</p>
      </section>
      <p class="privacy">${icon("lock", 18)}<span>WATnow never sees your password. What it reads stays on this computer.</span></p>
    </div>`;
}

app.addEventListener("change", (e) => {
  if (!e.target.matches("#school-select")) return;
  const school = schoolById(e.target.value);
  const btn = app.querySelector('[data-act="pick-school"]');
  btn.disabled = !school;
  btn.textContent = pickButtonLabel(school);
  app.querySelector(".pick-status").textContent = "";
});

/**
 * Asks Chrome for access to the school's site (Waterloo's is granted at install),
 * then saves the pick and opens the site so the student can sign in.
 * chrome.permissions.request has to run straight from the click, before any await.
 */
function pickSchool() {
  const school = schoolById(app.querySelector("#school-select")?.value);
  if (!school) return;
  const status = app.querySelector(".pick-status");
  const origins = [school.origin, ...(school.aliases || [])].map((o) => `${o}/*`);
  const ask = school.id === SCHOOLS[0].id ? Promise.resolve(true) : chrome.permissions.request({ origins }).catch(() => false);
  ask.then(async (granted) => {
    if (!granted) {
      status.textContent = `WATnow needs access to ${school.system} to read your deadlines. Select ${pickButtonLabel(school)} again and choose Allow.`;
      return;
    }
    await setSettings({ school: school.id });
    send("school:open");
  });
}

/* ------------------------------------------------------------------ */
/* Other whole-panel states                                            */
/* ------------------------------------------------------------------ */

function renderStateView(kind) {
  const views = {
    "signed-out": {
      mark: icon("lock", 24),
      title: `Sign in to ${lms()} first`,
      body: `WATnow reads ${lms()} through the session in this browser. Open ${lms()} and sign in. Your deadlines show up here once a ${lms()} page loads. If they don't, select Try again.`,
      action: `<div class="row-actions"><button class="btn btn-primary" data-act="open-learn">Open ${lms()}</button><button class="btn btn-quiet" data-act="retry">Try again</button></div>${changeSchoolHTML()}`,
    },
    offline: {
      mark: icon("alert", 24),
      title: `Couldn't reach ${lms()}`,
      body: "Check that this computer is online, then try again.",
      action: `<button class="btn btn-primary" data-act="retry">Try again</button>`,
    },
    error: {
      mark: icon("alert", 24),
      late: true,
      title: `Couldn't read ${lms()}`,
      body: `${lms()} didn't respond. Check that you're still signed in, then try again.`,
      action: `<button class="btn btn-primary" data-act="retry">Try again</button>`,
    },
    "no-courses": {
      mark: icon("info", 24),
      title: `No courses on ${lms()} this term`,
      body: `WATnow didn't find any courses for this term in your ${lms()} account. If ${lms()} lists your courses, select Try again.`,
      action: `<button class="btn btn-primary" data-act="retry">Try again</button>`,
    },
    empty: {
      mark: icon("check", 24),
      title: `No deadlines on ${lms()} yet`,
      body: "Your courses are there, but none of them have dated items yet. When a prof posts something with a due date, it shows up here.",
      action: "",
    },
    deleted: {
      mark: icon("check", 24),
      title: "Your data is deleted",
      body: `WATnow removed your deadlines and settings from this computer. It reads ${lms()} again only when you ask it to.`,
      action: `<button class="btn btn-primary" data-act="retry">Read ${lms()} again</button>`,
    },
  };
  const v = views[kind];
  app.innerHTML = `<section class="state"><div class="state-mark${v.late ? " is-late" : ""}">${v.mark}</div><h1>${esc(v.title)}</h1><p>${esc(v.body)}</p>${v.action}</section>`;
}

/** Signed out of a school the student may have picked by mistake: a way back to the picker. */
function changeSchoolHTML() {
  const school = settings && settings.mode === "live" ? currentSchool(settings) : null;
  if (!school) return "";
  return `<p class="pick-change">Not at ${esc(school.name)}? <button class="link-btn" data-act="change-school">Choose a different school</button></p>`;
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
  if (PREVIEW === "school" || needsSchool()) {
    setView("school");
    renderSchoolPicker();
    return;
  }
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
  if (needsSchool()) return;
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
    case "pick-school":
      pickSchool();
      break;
    case "change-school":
      setSettings({ school: null });
      break;
    case "open-learn":
      chrome.tabs.create({
        url: settings && settings.mode === "live" ? (currentSchool(settings) ? homeUrl(currentSchool(settings)) : `${liveBase(settings)}/d2l/home`) : `${(settings && settings.learnBase) || "https://learn.uwaterloo.ca"}/d2l/home/`,
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
  if (t.dataset.act === "cm-connect") connectCrowdmark();
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
    const before = settings;
    settings = changes.settings.newValue;
    applyTheme(settings.theme);
    // Picking a school (or going back to the picker) swaps the whole panel.
    if (before && (before.school || null) !== (settings.school || null) && view !== "settings") {
      route();
      if (!needsSchool()) send("panel:opened");
    }
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
  cmAllowed = PREVIEW ? false : await crowdmarkAllowed(settings);
  route();
  if (!PREVIEW) pingPanelOpen();
  if (!PREVIEW && !needsSchool() && (state.scan.status === "idle" || state.scan.status === "running") && !state.deletedAt) send("panel:opened");
  // The last check couldn't read Learn: try again now that the student is looking.
  if (!PREVIEW && state.scan.status === "done" && state.stale) send("panel:check");
})();

chrome.permissions.onAdded.addListener(refreshCm);
chrome.permissions.onRemoved.addListener(refreshCm);

window.addEventListener("online", () => {
  if (PREVIEW) return;
  if ((state.scan.status === "done" && state.stale) || (state.scan.status === "error" && state.errorKind === "offline")) send("panel:check");
});
