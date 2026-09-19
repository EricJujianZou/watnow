// Anonymous usage counts for the store build, so we can see how many people
// install WATnow and whether they keep opening it. Every event carries a random
// install ID, the version, the install date and how many days old the install
// is. Nothing from Learn is ever included. Demo builds send nothing.
//
// Three events:
//   install      once, when Chrome installs the extension
//   panel-open   every time the side panel is opened, for how often it gets used
//   day-active   at most once per local day, for retention. Because it fires
//                once per install per day, the count of day-active events with
//                day=7 is the number of installs that were still being used a
//                week in. Break the event down by the day property in Umami and
//                the retention curve is the list of numbers.

import { TESTER_BUILD } from "./build.js";

const UMAMI_URL = "https://cloud.umami.is/api/send";
// Shared with ugmi.ca. Filter Umami by the watnow tag or the hostname below.
const UMAMI_WEBSITE_ID = "cb84c6d3-69d1-4cdb-93b9-3589b58f981b";
const HOSTNAME = "watnow-extension";

/** Local calendar date, YYYY-MM-DD. Not UTC: a 9pm install in Toronto belongs
 *  to the day the student thinks it is, and day counts have to match that or
 *  every evening install reads as a day older than it is. */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(fromDate, toDate) {
  const [y1, m1, d1] = fromDate.split("-").map(Number);
  const [y2, m2, d2] = toDate.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

async function usageRecord() {
  const { usage } = await chrome.storage.local.get("usage");
  if (usage?.installId) {
    // Installs from before the local-date fix stored a UTC date. Leave it: the
    // cohort is a day out at worst and rewriting it would lose the install day.
    return usage;
  }
  const fresh = { installId: crypto.randomUUID(), installedOn: today(), lastActiveOn: null };
  await chrome.storage.local.set({ usage: fresh });
  return fresh;
}

/** True only for installs that came from the Chrome Web Store. Chrome adds an
 *  update_url to the installed manifest and an unpacked folder never has one,
 *  so this keeps development installs on our own machines out of the counts.
 *  Every uninstall wipes local storage, so a reinstall is a new install ID and
 *  reads as a new person. There is no way around that and no reason to want
 *  one, but it does mean a developer reinstalling all day inflates everything. */
function fromStore() {
  return Boolean(chrome.runtime.getManifest().update_url);
}

async function send(name, extra = {}) {
  if (!TESTER_BUILD || !fromStore()) return;
  try {
    const { installId, installedOn } = await usageRecord();
    const payload = {
      website: UMAMI_WEBSITE_ID,
      hostname: HOSTNAME,
      url: "/panel",
      title: "WATnow panel",
      language: navigator.language,
      name,
      tag: "watnow",
      id: installId,
      data: {
        install_id: installId,
        version: chrome.runtime.getManifest().version,
        installed_on: installedOn,
        day: daysBetween(installedOn, today()),
        ...extra,
      },
    };
    // The service worker has no screen object. Only the panel reports one.
    if (typeof screen !== "undefined") payload.screen = `${screen.width}x${screen.height}`;
    await fetch(UMAMI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "event", payload }),
    });
  } catch {
    // Counting must never break the extension.
  }
}

/** Once per install, from the service worker's onInstalled. The denominator:
 *  how many installs there are, including the ones that never open the panel. */
export async function pingInstall() {
  if (!TESTER_BUILD || !fromStore()) return;
  await send("install");
}

/** Every panel open. Counts opens, not people. */
export async function pingPanelOpen() {
  if (!TESTER_BUILD || !fromStore()) return;
  await send("panel-open");
  await pingDayActive("panel");
}

/** The retention event. Fires for the first real use of the day and then not
 *  again until tomorrow, so one event is one install still in use that day.
 *  `how` is "panel" or "reminder": opening the side panel and acting on a
 *  reminder both count as using WATnow. */
export async function pingDayActive(how) {
  if (!TESTER_BUILD || !fromStore()) return;
  try {
    const usage = await usageRecord();
    const day = today();
    if (usage.lastActiveOn === day) return;
    await chrome.storage.local.set({ usage: { ...usage, lastActiveOn: day } });
    await send("day-active", { how });
  } catch {
    // Counting must never break the extension.
  }
}
