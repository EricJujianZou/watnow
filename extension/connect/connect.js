/*
  "Connect Crowdmark", as a page in a tab.

  The panel is a sidebar on Gecko, and permissions.request() does not work in a
  Firefox sidebar: it rejects with "An unexpected error occurred" because the
  sidebar has no PopupNotifications to anchor the prompt to
  (https://bugzilla.mozilla.org/show_bug.cgi?id=1493396). The button there could
  only ever report that access was refused, however many times it was selected.

  So on Gecko the panel opens this page instead. It is an ordinary tab, where
  the prompt works. Once access is given it hands straight over to Crowdmark's
  sign-in, in this same tab, so the student ends up where they were going. That
  tab is also what the background reads Crowdmark through afterwards, since it
  may not carry the session itself. See src/content/crowdmark-bridge.js.

  Chrome opens the prompt from the side panel and never sends anyone here.
*/

import { brandMark, esc } from "../src/ui/icons.js";
import { getSettings } from "../src/core/store.js";
import { applyTheme } from "../src/ui/settings-view.js";
import { crowdmarkBase } from "../src/data/crowdmark-source.js";

const APP = chrome.i18n.getMessage("appName") || "WATnow";
const page = document.getElementById("page");

let settings = null;
let busy = false;

const signInUrl = () => `${crowdmarkBase(settings)}/sign-in/waterloo`;

/**
 * Granting access by hand, for a browser whose prompt never arrives. Firefox
 * lists every optional host permission on the add-on's own Permissions page,
 * with a switch, so access can be given there instead. onAdded is listening, so
 * turning it on carries straight on to Crowdmark without coming back here.
 */
function manualHTML() {
  return `
    <div class="sheet">
      <section class="set-section">
        <h2>Or turn it on yourself</h2>
        <p class="set-help">If no prompt appears, your browser can give ${esc(APP)} access from its own add-ons page:</p>
        <ol class="set-help">
          <li>Open <strong>about:addons</strong> and select ${esc(APP)}.</li>
          <li>Open the <strong>Permissions</strong> tab.</li>
          <li>Turn on <strong>Access your data for app.crowdmark.com</strong>.</li>
        </ol>
        <p class="set-help">This page carries on by itself once that is on.</p>
        <div class="row-actions" style="margin-top:12px">
          <button class="btn btn-quiet btn-sm" data-act="addons">Open the add-ons page</button>
        </div>
      </section>
    </div>`;
}

function render({ note = "", refused = false } = {}) {
  const label = refused ? "Try again" : "Connect Crowdmark";
  page.innerHTML = `
    <div class="page-head">
      <span class="mark-tile">${brandMark(40)}</span>
      <div>
        <h1>Connect Crowdmark</h1>
        <p>${esc(APP)} will show your Crowdmark deadlines beside your Learn ones.</p>
      </div>
    </div>
    <div class="sheet">
      <section class="set-section">
        <p class="set-help">
          Your browser will ask whether ${esc(APP)} can access <strong>app.crowdmark.com</strong>. Choose
          <strong>Allow</strong>, and this tab takes you to Crowdmark to sign in. ${esc(APP)} only ever reads your
          courses and their due dates, and never sends anything to Crowdmark.
        </p>
        <div class="row-actions" style="margin-top:16px">
          <button class="btn btn-primary" data-act="connect" ${busy ? "disabled" : ""}>${busy ? "Connecting…" : label}</button>
          <button class="btn btn-quiet" data-act="close">Not now</button>
        </div>
        <p class="status-text" role="status">${esc(note)}</p>
      </section>
    </div>
    ${refused ? manualHTML() : ""}`;
}

/**
 * Asks for the origins and says whether access is there afterwards.
 *
 * What request() hands back can't be trusted on its own. Gecko's chrome
 * namespace is callback-based for some APIs, so awaiting it can give undefined
 * even though the student chose Allow, and in a sidebar it rejects outright
 * (bugzilla 1493396). permissions.contains() afterwards is the answer that
 * counts; the returned value only covers a browser that granted it a moment
 * later. The error text is kept so a refusal can say what actually happened.
 *
 * browser.* is preferred where it exists, since that is the promise-based
 * namespace on Gecko.
 */
async function askFor(origins) {
  const api = (globalThis.browser && globalThis.browser.permissions) || chrome.permissions;
  let returned;
  let error = "";
  try {
    // Straight from the click, with nothing awaited first, or the prompt never shows.
    returned = await api.request({ origins });
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const has = await chrome.permissions.contains({ origins }).catch(() => false);
  return { granted: has || returned === true, error };
}

async function connect() {
  if (busy) return;
  const origins = [`${crowdmarkBase(settings)}/*`];
  const { granted, error } = await askFor(origins);
  if (!granted) {
    const why = error ? ` Your browser said: ${error}` : "";
    render({ note: `${APP} can't read Crowdmark without access to it. Select Try again and choose Allow.${why}`, refused: true });
    return;
  }
  await handOver();
}

/** Access is there: let the background set up, then take this tab to Crowdmark. */
async function handOver() {
  if (busy) return;
  busy = true;
  render();
  // Lets the background register the Crowdmark bridge before this tab leaves for
  // Crowdmark, so the page it lands on can be read through.
  await chrome.runtime.sendMessage({ type: "crowdmark:connect" }).catch(() => null);
  location.href = signInUrl();
}

page.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  if (t.dataset.act === "connect") connect();
  if (t.dataset.act === "close") window.close();
  if (t.dataset.act === "addons") {
    // Firefox allows this; anywhere it doesn't, the steps above still say where to go.
    chrome.tabs.create({ url: "about:addons" }).catch(() => {});
  }
});

/** Access given from the browser's own add-ons page lands here, and goes on as if the prompt had worked. */
chrome.permissions?.onAdded?.addListener(async () => {
  if (busy) return;
  const origins = [`${crowdmarkBase(settings)}/*`];
  const has = await chrome.permissions.contains({ origins }).catch(() => false);
  if (has) handOver();
});

(async function init() {
  settings = await getSettings();
  applyTheme(settings.theme);
  render();
})();
