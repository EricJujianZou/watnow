import { calendarError, invalidateGoogleToken } from "./google-auth.js";
import { CALENDAR_NAME, CALENDAR_MARKER } from "./config.js";

const BASE = "https://www.googleapis.com/calendar/v3";
const part = encodeURIComponent;

/** Bound to one run's verified account. The guard runs before EVERY request. */
export function calendarApi(token, guard = async () => {}) {
  async function request(path, { method = "GET", body } = {}) {
    await guard();
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        mode: "cors",
        credentials: "omit",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw calendarError("network", "Couldn't reach Google. Your calendar changes are queued.", true);
    }
    if (res.status === 401) {
      await invalidateGoogleToken(token);
      throw calendarError("token", "Google authorization expired. Retrying shortly.", true);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const reason = data.error?.errors?.[0]?.reason;
      const retry = res.status === 429 || res.status >= 500 || ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason);
      const message = retry ? "Google is busy. Your calendar changes are queued." : "Google couldn't update the WATNOW calendar. Check its access and reconnect.";
      throw Object.assign(calendarError("api", message, retry), { status: res.status });
    }
    try {
      return res.status === 204 ? null : await res.json();
    } catch {
      throw calendarError("network", "Google's response was interrupted. Retrying shortly.", true);
    }
  }

  return {
    createCalendar: () => request("/calendars", { method: "POST", body: { summary: CALENDAR_NAME, description: CALENDAR_MARKER } }),
    getCalendar: (id) => request(`/calendars/${part(id)}`),
    getEvent: (id, eventId) => request(`/calendars/${part(id)}/events/${part(eventId)}`),
    insertEvent: (id, event) => request(`/calendars/${part(id)}/events`, { method: "POST", body: event }),
    patchEvent: (id, eventId, event) => request(`/calendars/${part(id)}/events/${part(eventId)}`, { method: "PATCH", body: event }),
    deleteEvent: (id, eventId) => request(`/calendars/${part(id)}/events/${part(eventId)}`, { method: "DELETE" }),
  };
}
