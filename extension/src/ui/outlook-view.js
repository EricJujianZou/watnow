// The Outlook calendar section in settings: the email to sync to, connect,
// sync now and disconnect. Hidden until the build has an Outlook client ID
// (see src/calendar/outlook-config.js).
import { esc } from "./icons.js";
import { fmtAgo } from "../core/dates.js";
import { outlookConfigured } from "../calendar/outlook-config.js";

// Microsoft's sign-in site, where WATnow swaps the sign-in for a token. Asked
// for on the Connect click: the browser only shows its prompt for a click.
const MICROSOFT_LOGIN = ["https://login.microsoftonline.com/*"];

/** Asks for access to Microsoft's sign-in site. Must run straight from the click, before anything is awaited. */
function askForMicrosoft() {
  const api = (globalThis.browser && globalThis.browser.permissions) || chrome.permissions;
  return Promise.resolve(api.request({ origins: MICROSOFT_LOGIN }))
    .catch(() => false)
    .then(async (granted) => granted === true || (await chrome.permissions.contains({ origins: MICROSOFT_LOGIN }).catch(() => false)));
}

function statusText(o) {
  if (o.status === "connecting") return "Finish signing in to Microsoft in the window that opened.";
  if (o.error) return o.error;
  if (o.status === "syncing") return "Syncing…";
  if (o.pending) return "Sync queued.";
  if (o.lastSyncAt) return `Last synced ${fmtAgo(o.lastSyncAt, new Date())}.`;
  return "";
}

export function outlookSettingsHTML(o) {
  if (!outlookConfigured()) return "";
  const connected = o.enabled && o.account;
  const busy = o.status === "connecting";
  const needsSignIn = o.status === "reconnect";
  const failed = o.status === "error";
  return `
    <h2 id="set-outlook">Outlook calendar</h2>
    <p class="set-help">Your deadlines go in a separate WATnow calendar in Outlook, and change there when they change here.</p>
    ${
      connected
        ? `<p class="set-help">Syncing to <strong>${esc(o.account.email || o.email)}</strong></p>
      <div class="row-actions outlook-actions">
        <button class="btn btn-primary btn-sm" data-outlook-act="${needsSignIn ? "connect" : "sync"}">${needsSignIn ? "Sign in again" : failed ? "Try again" : "Sync now"}</button>
        <button class="btn btn-quiet btn-sm" data-outlook-act="change">Change email</button>
        <button class="btn btn-quiet btn-sm" data-outlook-act="disconnect">Disconnect</button>
      </div>`
        : `<form class="outlook-form" data-outlook-form novalidate>
        <label class="outlook-field"><span>Outlook email</span>
          <input class="input" type="email" name="email" autocomplete="email" placeholder="name@outlook.com" value="${esc(o.email || "")}" ${busy ? "disabled" : ""} required></label>
        <div class="row-actions">
          <button class="btn btn-primary btn-sm" type="submit" ${busy ? "disabled" : ""}>${busy ? "Connecting…" : "Connect Outlook"}</button>
          ${busy ? '<button class="btn btn-quiet btn-sm" type="button" data-outlook-act="disconnect">Cancel</button>' : ""}
        </div>
      </form>`
    }
    <p class="status-text outlook-status" role="status">${esc(statusText(o))}</p>
    <p class="set-help outlook-fine">Connecting sends course names, deadline titles, due dates and links to that Microsoft account. Outlook's own reminders are off on these events, so you keep WATnow's. Disconnecting stops syncing and leaves the events already in Outlook. <a href="https://watnow.ugmi.ca/privacy/" target="_blank" rel="noopener noreferrer">Privacy policy<span class="sr-only"> (opens in a new tab)</span></a></p>`;
}

/** Redraws the section from the saved state, keeping an email being typed. */
export function updateOutlookView(root, o) {
  const section = root.querySelector("[data-outlook-settings]");
  if (!section) return;
  if (!outlookConfigured()) {
    section.innerHTML = "";
    return;
  }
  const typing = section.querySelector('input[name="email"]');
  const draft = typing && document.activeElement === typing ? typing.value : null;
  section.innerHTML = outlookSettingsHTML(o);
  const input = section.querySelector('input[name="email"]');
  if (input && draft != null) {
    input.value = draft;
    input.focus();
  }
}

export function wireOutlookControls(root) {
  if (root.dataset.outlookWired) return;
  root.dataset.outlookWired = "1";
  const status = () => root.querySelector(".outlook-status");
  const say = (text) => {
    if (status() && text) status().textContent = text;
  };

  root.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-outlook-form]");
    if (!form) return;
    e.preventDefault();
    const email = String(new FormData(form).get("email") || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      say("Type the email you use for Outlook.");
      form.elements.email.focus();
      return;
    }
    if (!(await askForMicrosoft())) {
      say("WATnow needs access to Microsoft's sign-in page to connect Outlook. Select Connect Outlook and choose Allow.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "outlook:connect", email }).catch(() => null);
    if (!res) say("WATnow couldn't start connecting. Reopen the panel and try again.");
    else if (!res.ok) say(res.reason);
    else say(res.note);
  });

  root.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-outlook-act]");
    if (!button || button.disabled) return;
    const act = button.dataset.outlookAct;
    button.disabled = true;
    let res;
    if (act === "connect") {
      if (!(await askForMicrosoft())) {
        if (button.isConnected) button.disabled = false;
        say("WATnow needs access to Microsoft's sign-in page to connect Outlook. Select Sign in again and choose Allow.");
        return;
      }
      // Signing in again: the background uses the email already saved.
      res = await chrome.runtime.sendMessage({ type: "outlook:connect" }).catch(() => null);
    } else if (act === "change") {
      res = await chrome.runtime.sendMessage({ type: "outlook:disconnect" }).catch(() => null);
    } else {
      res = await chrome.runtime.sendMessage({ type: `outlook:${act}` }).catch(() => null);
    }
    if (button.isConnected) button.disabled = false;
    if (res && !res.ok) say(res.reason);
  });
}
