// Anonymous usage count for the store build, so we can see how many people
// install WATnow and whether they keep opening it. Each panel open sends one
// event to Umami with a random install ID, the version and the install date.
// Nothing from Learn is ever included. Demo builds send nothing.

import { TESTER_BUILD } from "./build.js";

const UMAMI_URL = "https://cloud.umami.is/api/send";
// Shared with ugmi.ca. Filter Umami by the watnow tag or the hostname below.
const UMAMI_WEBSITE_ID = "cb84c6d3-69d1-4cdb-93b9-3589b58f981b";
const HOSTNAME = "watnow-extension";

async function installInfo() {
  const { usage } = await chrome.storage.local.get("usage");
  if (usage?.installId) return usage;
  const fresh = { installId: crypto.randomUUID(), installedOn: new Date().toISOString().slice(0, 10) };
  await chrome.storage.local.set({ usage: fresh });
  return fresh;
}

export async function pingPanelOpen() {
  if (!TESTER_BUILD) return;
  try {
    const { installId, installedOn } = await installInfo();
    const days = Math.floor((Date.now() - Date.parse(installedOn)) / 86400000);
    await fetch(UMAMI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "event",
        payload: {
          website: UMAMI_WEBSITE_ID,
          hostname: HOSTNAME,
          url: "/panel",
          title: "WATnow panel",
          language: navigator.language,
          screen: `${screen.width}x${screen.height}`,
          name: "panel-open",
          tag: "watnow",
          id: installId,
          data: {
            install_id: installId,
            version: chrome.runtime.getManifest().version,
            installed_on: installedOn,
            days_since_install: days,
          },
        },
      }),
    });
  } catch {
    // Counting must never break the panel.
  }
}
