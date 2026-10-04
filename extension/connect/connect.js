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
    </div>`;
}

async function connect() {
  if (busy) return;
  const origins = [`${crowdmarkBase(settings)}/*`];
  let granted = false;
  try {
    // Straight from the click, with nothing awaited first, or the prompt is refused outright.
    granted = await chrome.permissions.request({ origins });
  } catch {
    granted = false;
  }
  if (!granted) {
    render({ note: `${APP} can't read Crowdmark without access to it. Select Try again and choose Allow.`, refused: true });
    return;
  }
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
});

(async function init() {
  settings = await getSettings();
  applyTheme(settings.theme);
  render();
})();
