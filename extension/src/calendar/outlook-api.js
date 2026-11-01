import { calendarError } from "./google-auth.js";
import { GRAPH_BASE, OUTLOOK_CALENDAR_NAME } from "./outlook-config.js";
import { WATNOW_PROP } from "./outlook-model.js";

const part = encodeURIComponent;

/** Retry-After is seconds, or (rarely) an HTTP date. Default to a minute. */
function retryAfterSeconds(res) {
  const raw = res.headers?.get?.("Retry-After");
  if (raw == null || raw === "") return 60;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 60;
}

/** OData string literals escape a single quote by doubling it. */
function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Bound to one run's verified account. The guard runs before EVERY request. */
export function outlookApi(token, guard = async () => {}) {
  // `path` is relative to GRAPH_BASE, or a full @odata.nextLink URL
  async function request(path, { method = "GET", body, gone = false } = {}) {
    await guard();
    let res;
    try {
      res = await fetch(path.startsWith("https://") ? path : GRAPH_BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw calendarError("network", "Couldn't reach Outlook. Your calendar changes are queued.", true);
    }
    if (res.status === 401) {
      throw calendarError("token", "Outlook sign-in expired. Retrying shortly.", true);
    }
    // Deleting something already deleted is a success
    if (gone && (res.status === 404 || res.status === 410)) return null;
    if (res.status === 429 || res.status >= 500) {
      throw Object.assign(calendarError("api", "Outlook is busy. Your calendar changes are queued.", true), {
        status: res.status,
        retryAfter: retryAfterSeconds(res),
      });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(calendarError("api", "Outlook couldn't update the WATnow calendar. Check its access and reconnect.", false), {
        status: res.status,
        graphCode: data.error?.code,
      });
    }
    try {
      return res.status === 204 ? null : await res.json();
    } catch {
      throw calendarError("network", "Outlook's response was interrupted. Retrying shortly.", true);
    }
  }

  // Follow @odata.nextLink until Graph stops sending one
  async function all(path) {
    const out = [];
    let next = path;
    while (next) {
      const page = await request(next);
      out.push(...(page?.value || []));
      next = page?.["@odata.nextLink"] || null;
    }
    return out;
  }

  return {
    me: () => request("/me?$select=displayName,mail,userPrincipalName,id"),
    listCalendars: () => all("/me/calendars?$select=id,name"),
    createCalendar: (name = OUTLOOK_CALENDAR_NAME) => request("/me/calendars", { method: "POST", body: { name } }),
    getCalendar: (id) => request(`/me/calendars/${part(id)}`),
    // Graph documents this filter on /me/events (the whole mailbox), not on one
    // calendar's events, so it searches there and then checks the calendar. The
    // value match ignores case, and the response leaves the property out, so it's
    // read back with $expand and compared exactly.
    async findEventByKey(calendarId, key) {
      const filter = `singleValueExtendedProperties/Any(ep: ep/id eq ${literal(WATNOW_PROP)} and ep/value eq ${literal(key)})`;
      const expand = `singleValueExtendedProperties($filter=id eq ${literal(WATNOW_PROP)})`;
      const page = await request(`/me/events?$filter=${part(filter)}&$expand=${part(expand)}&$select=id,calendarId&$top=10`);
      const exact = (page?.value || []).find((ev) => (ev.singleValueExtendedProperties || []).some((p) => p.id === WATNOW_PROP && p.value === key));
      if (!exact) return null;
      return !exact.calendarId || exact.calendarId === calendarId ? exact : null;
    },
    createEvent: (calendarId, event) => request(`/me/calendars/${part(calendarId)}/events`, { method: "POST", body: event }),
    patchEvent: (eventId, event) => request(`/me/events/${part(eventId)}`, { method: "PATCH", body: event }),
    deleteEvent: (eventId) => request(`/me/events/${part(eventId)}`, { method: "DELETE", gone: true }),
  };
}
