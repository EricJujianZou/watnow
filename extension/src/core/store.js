// Everything WATnow keeps lives in chrome.storage.local on this computer.
//   settings  the student's choices
//   state     what WATnow has read from Learn
//   catalog   DEMO only: the fake Learn that the mock site and demo source share
//   liveDebug LIVE only: what the last read of real Learn returned, for "Copy debug info"

import { TESTER_BUILD } from "./build.js";

export const DEFAULT_SETTINGS = {
  mode: TESTER_BUILD ? "live" : "demo",
  theme: "system",
  learnBase: TESTER_BUILD ? "https://learn.uwaterloo.ca" : "http://localhost:8080",
  // liveBaseOverride: set only by the local test harness, see liveBase() in live-source.js
  reminders: {
    leads: {
      assignment: ["2d", "morning", "2h"],
      lab: ["2d", "morning", "2h"],
      quiz: ["morning", "2h"],
      discussion: ["morning"],
      content: ["morning"],
    },
    mutedCourses: [],
    quietStart: 23,
    quietEnd: 8,
    demoAutoSend: false,
  },
};

export function emptyState() {
  return {
    scan: { status: "idle", courses: [], startedAt: null, finishedAt: null },
    student: null,
    courses: [],
    items: [],
    lastSyncAt: null,
    syncing: false,
    error: null,
    // signed-out | offline | error: why the panel shows a whole-panel screen instead of the list
    errorKind: null,
    // { kind: "unreachable" | "no-tab" | "signed-out", at, online }: the last check
    // couldn't read Learn, so the list is what the last good read found
    stale: null,
    seq: 0,
    lastEvent: null,
    demo: { moveStep: 0 },
    sent: {},
  };
}

function mergeSettings(saved) {
  const s = saved || {};
  const r = s.reminders || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    ...(TESTER_BUILD ? { mode: "live" } : {}),
    reminders: {
      ...DEFAULT_SETTINGS.reminders,
      ...r,
      leads: { ...DEFAULT_SETTINGS.reminders.leads, ...(r.leads || {}) },
    },
  };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return mergeSettings(settings);
}

export async function setSettings(patchOrFn) {
  const current = await getSettings();
  const next = typeof patchOrFn === "function" ? patchOrFn(structuredClone(current)) || current : { ...current, ...patchOrFn };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return state ? { ...emptyState(), ...state } : emptyState();
}

export async function setState(state) {
  await chrome.storage.local.set({ state });
}

export async function getCatalog() {
  const { catalog } = await chrome.storage.local.get("catalog");
  return catalog || null;
}

export async function setCatalog(catalog) {
  await chrome.storage.local.set({ catalog });
}

export async function getFilter() {
  try {
    const { filter } = await chrome.storage.session.get("filter");
    return filter || "all";
  } catch {
    return "all";
  }
}

export async function setFilter(filter) {
  try {
    await chrome.storage.session.set({ filter });
  } catch {
    /* session storage unavailable */
  }
}
