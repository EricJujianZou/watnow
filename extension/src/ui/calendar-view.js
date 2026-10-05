import { esc } from "./icons.js";
import { fmtAgo } from "../core/dates.js";
import { googleConfigured } from "../calendar/config.js";

function statusText(c) {
  if (c.status === "connecting") return "Choose your Google account.";
  if (c.error) return c.error;
  if (c.status === "syncing") return "Syncing…";
  if (c.pending) return "Sync queued.";
  if (c.lastSyncAt) return `Last synced ${fmtAgo(c.lastSyncAt, new Date())}.`;
  return "";
}

export function calendarSettingsHTML(c) {
  if (!googleConfigured()) return "";
  const connected = c.enabled && c.account;
  const busy = c.status === "connecting";
  return `
    <h2 id="set-calendar">Google Calendar</h2>
    ${connected ? `<p class="set-help"><strong>${esc(c.account.email)}</strong></p>` : ""}
    <p class="set-help">Deadlines and date changes sync while Chrome is open.</p>
    <div class="row-actions calendar-actions">
      ${connected ? `
        <button class="btn btn-primary btn-sm" data-calendar-act="${c.status === "reconnect" || c.status === "error" ? "connect" : "sync"}">${c.status === "reconnect" || c.status === "error" ? "Reconnect Google Calendar" : "Sync now"}</button>
        <button class="btn btn-quiet btn-sm" data-calendar-act="change-account">Change account</button>
        <button class="btn btn-quiet btn-sm" data-calendar-act="disconnect">Disconnect</button>` : `
        <button class="btn btn-primary btn-sm" data-calendar-act="connect" ${busy ? "disabled" : ""}>${busy ? "Connecting…" : "Connect Google Calendar"}</button>
        ${busy ? '<button class="btn btn-quiet btn-sm" data-calendar-act="disconnect">Cancel</button>' : ""}`}
    </div>
    <p class="status-text calendar-status" role="status">${esc(statusText(c))}</p>
    <p class="set-help calendar-fine">Connecting shares course and deadline details with Google. <a href="https://watnow.ugmi.ca/privacy/" target="_blank" rel="noopener noreferrer">Privacy policy<span class="sr-only"> (opens in a new tab)</span></a></p>
    <details class="calendar-details">
      <summary>Sync details</summary>
      <p class="set-help">Events go in a separate WATNOW calendar. Google receives course names, titles, dates, completion status and assignment links. Google reminders are off. Disconnecting, deleting local data or uninstalling keeps existing Google events. You can delete them in Google Calendar.</p>
    </details>`;
}

export function updateCalendarView(root, c) {
  const settings = root.querySelector("[data-calendar-settings]");
  if (settings) {
    if (!googleConfigured()) {
      settings.innerHTML = "";
      return;
    }
    const expanded = settings.querySelector("details")?.open;
    settings.innerHTML = calendarSettingsHTML(c);
    const details = settings.querySelector("details");
    if (details) details.open = !!expanded;
  }
}

export function wireCalendarControls(root) {
  if (root.dataset.calendarWired) return;
  root.dataset.calendarWired = "1";
  root.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-calendar-act]");
    if (!button || button.disabled) return;
    button.disabled = true;
    const type = `calendar:${button.dataset.calendarAct}`;
    const response = await chrome.runtime.sendMessage({ type }).catch(() => ({ ok: false, reason: "WATnow couldn't connect. Reopen the panel and try again." }));
    if (button.isConnected) button.disabled = false;
    if (response && !response.ok) {
      const status = root.querySelector(".calendar-status");
      if (status) status.textContent = response.reason || "Google Calendar couldn't connect. Try again later.";
    }
  });
}
