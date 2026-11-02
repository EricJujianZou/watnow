// A strict, stateful fake of the Microsoft identity platform token endpoint and
// the slice of Microsoft Graph v1.0 that WATnow's Outlook sync uses.
//
// "Strict" means it refuses what real Graph refuses (unknown $select fields,
// malformed $filter/$expand, unknown or read-only body properties, ...) instead
// of accepting anything, so a request shape bug fails a test the way it would
// fail against Microsoft. Every rule names the page it comes from. Where the
// docs are silent, the behaviour is a configurable assumption and says so.
//
// Docs (all fetched and checked 2026-11-01):
//   TOKEN   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
//   EVENT   https://learn.microsoft.com/en-us/graph/api/resources/event
//   CREATE  https://learn.microsoft.com/en-us/graph/api/calendar-post-events
//   UPDATE  https://learn.microsoft.com/en-us/graph/api/event-update
//   LIST    https://learn.microsoft.com/en-us/graph/api/user-list-events
//   CAL     https://learn.microsoft.com/en-us/graph/api/resources/calendar
//   NEWCAL  https://learn.microsoft.com/en-us/graph/api/user-post-calendars
//   EPGET   https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get
//   EPPOST  https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-post-singlevalueextendedproperties
//   EPID    https://learn.microsoft.com/en-us/graph/api/resources/extended-properties-overview
//   DTTZ    https://learn.microsoft.com/en-us/graph/api/resources/datetimetimezone
//   BODY    https://learn.microsoft.com/en-us/graph/api/resources/itembody
//   PAGING  https://learn.microsoft.com/en-us/graph/paging
//   THROTTLE https://learn.microsoft.com/en-us/graph/throttling
//   USER    https://learn.microsoft.com/en-us/graph/api/resources/user
import { createHash, randomUUID } from "node:crypto";

export const GRAPH = "https://graph.microsoft.com/v1.0";
export const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

// EVENT: every property in the "Properties" table. `calendarId` is NOT one of
// them (that was the bug in 9380978); `calendar` is a navigation property.
export const EVENT_PROPS = new Set([
  "allowNewTimeProposals", "attendees", "body", "bodyPreview", "cancelledOccurrences", "categories", "changeKey",
  "createdDateTime", "end", "hasAttachments", "hideAttendees", "iCalUId", "id", "importance", "isAllDay", "isCancelled",
  "isDraft", "isOnlineMeeting", "isOrganizer", "isReminderOn", "lastModifiedDateTime", "location", "locations",
  "onlineMeeting", "onlineMeetingProvider", "onlineMeetingUrl", "organizer", "originalEndTimeZone", "originalStart",
  "originalStartTimeZone", "recurrence", "reminderMinutesBeforeStart", "responseRequested", "responseStatus",
  "sensitivity", "seriesMasterId", "showAs", "start", "subject", "transactionId", "type", "webLink",
]);
// EVENT: properties the table marks read-only (or that are server computed), so a create can't set them.
const EVENT_READ_ONLY = new Set([
  "bodyPreview", "cancelledOccurrences", "changeKey", "createdDateTime", "hasAttachments", "iCalUId", "id", "isCancelled",
  "isDraft", "isOrganizer", "lastModifiedDateTime", "onlineMeeting", "onlineMeetingUrl", "originalStart", "responseStatus",
  "seriesMasterId", "type", "webLink",
]);
// EPPOST: extended properties ride along in the create/patch body.
const EVENT_CREATE_KEYS = new Set([...[...EVENT_PROPS].filter((p) => !EVENT_READ_ONLY.has(p)), "singleValueExtendedProperties", "multiValueExtendedProperties"]);
// UPDATE: "The following table specifies the properties that can be updated." Plus
// singleValueExtendedProperties (EPPOST: "PATCH /me/events/{id}" creates/updates them),
// plus transactionId only when unchanged (EVENT: "you can't change transactionId in a subsequent update").
const EVENT_UPDATE_KEYS = new Set([
  "attendees", "body", "categories", "end", "hideAttendees", "importance", "isAllDay", "isOnlineMeeting", "isReminderOn",
  "location", "locations", "onlineMeetingProvider", "recurrence", "reminderMinutesBeforeStart", "responseRequested",
  "sensitivity", "showAs", "start", "subject", "singleValueExtendedProperties", "transactionId",
]);
// EVENT/UPDATE: showAs "The possible values are: free, tentative, busy, oof, workingElsewhere, unknown."
const SHOW_AS = new Set(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]);
// CAL: calendar properties.
export const CALENDAR_PROPS = new Set([
  "allowedOnlineMeetingProviders", "canEdit", "canShare", "canViewPrivateItems", "changeKey", "color",
  "defaultOnlineMeetingProvider", "hexColor", "id", "isDefaultCalendar", "isRemovable", "isSharedWithMe",
  "isTallyingResponses", "name", "owner",
]);
// NEWCAL: body is a calendar object; read-only ones (id, changeKey, hexColor, isSharedWithMe) can't be posted.
const CALENDAR_CREATE_KEYS = new Set(["name", "color"]);
// USER: the user properties WATnow reads.
const USER_PROPS = new Set(["id", "displayName", "mail", "userPrincipalName", "givenName", "surname", "preferredLanguage", "jobTitle", "mobilePhone", "officeLocation", "businessPhones"]);

// EPID: "{type} {guid} Name {name}" or "{type} {guid} Id {id}" or "{type} {proptag}".
const EP_TYPES = "(?:Binary|Boolean|CLSID|Currency|Double|Float|Integer|Long|Object|Short|String|SystemTime)";
const EP_ID = new RegExp(`^${EP_TYPES} (?:\\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\} (?:Name \\S.*|Id 0x[0-9a-fA-F]{1,4})|0x[0-9a-fA-F]{4})$`);
// DTTZ: dateTime is "{date}T{time}; for example, 2017-08-29T04:00:00.0000000" (no offset; the zone is separate).
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?$/;
// DTTZ: Windows zone names or the listed additional (IANA) zones. A small accepted set, plus UTC.
const TIME_ZONES = new Set(["UTC", "Etc/GMT", "Eastern Standard Time", "Pacific Standard Time", "America/Toronto", "America/New_York", "America/Los_Angeles", "Europe/London"]);
// OData string literal: quote doubled inside.
const LIT = "'((?:[^']|'')*)'";
// EPGET: "GET /me/events?$filter=singleValueExtendedProperties/Any(ep: ep/id eq '{id_value}' and ep/value eq '{property_value}')"
// (string properties may also use ne, contains(), startswith()). Example 3 on the same page uses `any(ep:ep/Id ...`.
const FILTER = new RegExp(`^singleValueExtendedProperties/[Aa]ny\\(ep: ?ep/[Ii]d eq ${LIT} and (?:ep/[Vv]alue (eq|ne) ${LIT}|(contains|startswith)\\(ep/[Vv]alue, ?${LIT}\\))\\)$`);
// EPGET: "$expand=singleValueExtendedProperties($filter=id eq '{id_value}')"
const EXPAND = new RegExp(`^singleValueExtendedProperties\\(\\$filter=id eq ${LIT}\\)$`);
const unq = (s) => s.replace(/''/g, "'");

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function header(init, name) {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

// A network failure the fake injects on purpose (so a real TypeError from a fake bug isn't mistaken for one).
class InjectedNetworkError extends TypeError {}

const json = (status, body, headers = {}) =>
  status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/**
 * @param {object} opts
 *  clientId                  the only client_id the token endpoint accepts
 *  redirectUri               the registered (Mobile and desktop) redirect URI
 *  originStripped()          true when the browser would NOT send Origin to the token endpoint
 *                            (i.e. the DNR rule is installed). Node never sends Origin, so the
 *                            test decides from the recorded DNR rules what a browser would do.
 *  calendarPageSize          server page size for GET /me/calendars (PAGING: "Different APIs might have different default and maximum page sizes")
 *  eventsMaxTop              largest $top accepted on /me/events (assumption; not documented for events)
 *  duplicateCalendarName     "409" | "allow"   NEWCAL documents no duplicate-name behaviour, so both are modelled
 *  transactionIdScope        "live" | "ever"   EVENT says transactionId avoids "redundant POST operations in case of client
 *                            retries"; whether a deleted event's id still dedupes is not documented, so both are modelled
 *  revokeRotatedRefreshTokens TOKEN: old refresh tokens "aren't revoked" but "You're expected to discard" them; strict = revoke
 */
export function createStrictGraph(opts = {}) {
  const cfg = {
    clientId: "test-client",
    redirectUri: "https://watnow-test-id.chromiumapp.org/outlook",
    originStripped: () => true,
    calendarPageSize: 10,
    eventsMaxTop: 1000,
    duplicateCalendarName: "409",
    transactionIdScope: "live",
    revokeRotatedRefreshTokens: true,
    accessTokenSeconds: 3600,
    ...opts,
  };
  const accounts = new Map();
  const refreshTokens = new Map(); // token -> { accountId, scope, revoked }
  const accessTokens = new Map(); // token -> { accountId, expiresAt, revoked }
  const codes = new Map(); // code -> { accountId, challenge, redirect, scope, used }
  const pages = new Map(); // skiptoken -> { kind, items, select, expandId, accountId }
  const log = []; // every request, in order
  const violations = []; // every request refused for breaking a documented rule
  const faults = new Map(); // graph request index -> fault
  const hooks = new Map(); // graph request index -> async fn run before the request is handled
  const rules = []; // { when(entry) -> bool, fault, times } faults chosen by request shape
  let graphIndex = 0;
  let seq = 0;

  function addAccount({ id, mail, displayName = "Student", upn = mail }) {
    const a = { id, mail, upn, displayName, calendars: new Map(), events: new Map(), txn: new Map() };
    a.calendars.set(`cal-default-${id}`, { id: `cal-default-${id}`, name: "Calendar", isDefaultCalendar: true });
    accounts.set(id, a);
    return a;
  }

  function issue(accountId, scope) {
    const access = `at-${accountId}-${++seq}`;
    const refresh = `rt-${accountId}-${++seq}`;
    accessTokens.set(access, { accountId, expiresAt: Date.now() + cfg.accessTokenSeconds * 1000, revoked: false });
    refreshTokens.set(refresh, { accountId, scope, revoked: false });
    return {
      token_type: "Bearer",
      access_token: access,
      refresh_token: refresh,
      expires_in: cfg.accessTokenSeconds,
      // TOKEN: scope is "The scopes that the access_token is valid for"; Microsoft answers with full URIs.
      scope: "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read",
    };
  }

  /** A refresh token as if the student had signed in earlier (for seeding storage). */
  function seedRefreshToken(accountId) {
    const t = `rt-${accountId}-${++seq}`;
    refreshTokens.set(t, { accountId, scope: "calendars.readwrite user.read offline_access", revoked: false });
    return t;
  }

  const normScopes = (s) => String(s || "").toLowerCase().split(/\s+/).filter(Boolean).map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//, ""));

  // ---------- authorize (driven from chrome.identity.launchWebAuthFlow) ----------
  function authorize(urlString, accountId) {
    const url = new URL(urlString);
    const p = url.searchParams;
    const need = (cond, why) => {
      if (!cond) {
        violations.push({ kind: "authorize", why });
        throw new Error(`authorize refused: ${why}`);
      }
    };
    need(url.origin + url.pathname === AUTHORIZE_URL, "wrong authorize endpoint");
    need(p.get("client_id") === cfg.clientId, "client_id");
    need(p.get("response_type") === "code", "response_type must be code");
    need(p.get("redirect_uri") === cfg.redirectUri, "redirect_uri must match the registered one");
    need(normScopes(p.get("scope")).includes("offline_access"), "offline_access needed for a refresh token");
    need(p.get("code_challenge") && p.get("code_challenge_method") === "S256", "PKCE S256");
    need(p.get("state"), "state");
    need(accounts.has(accountId), "unknown account");
    const code = `code-${++seq}`;
    codes.set(code, { accountId, challenge: p.get("code_challenge"), redirect: p.get("redirect_uri"), scope: p.get("scope"), used: false });
    log.push({ kind: "authorize", accountId });
    return `${cfg.redirectUri}?code=${code}&state=${encodeURIComponent(p.get("state"))}`;
  }

  // ---------- token endpoint ----------
  function tokenError(status, error, description) {
    violations.push({ kind: "token", error, description });
    return json(status, { error, error_description: description, error_codes: [] });
  }

  async function tokenEndpoint(url, init) {
    const entry = { kind: "token", url, method: init.method, originStripped: cfg.originStripped() };
    log.push(entry);
    // TOKEN: "POST /{tenant}/oauth2/v2.0/token ... Content-Type: application/x-www-form-urlencoded"
    if (init.method !== "POST") return tokenError(400, "invalid_request", "AADSTS900561: The endpoint only accepts POST requests.");
    if (!String(header(init, "Content-Type") || "").startsWith("application/x-www-form-urlencoded")) return tokenError(400, "invalid_request", "form encoding required");
    // TOKEN: "the Microsoft identity platform returns an error if you attempt to use a spa redirect URI without an Origin header"
    // and, for the redirect WATnow registers (Mobile and desktop, not spa), a request WITH an Origin
    // is refused: "cross-origin token redemption is permitted only for the 'Single-Page Application' client-type"
    // (the AADSTS9002326 text). A browser always sends Origin from an extension unless the DNR rule strips it.
    if (header(init, "Origin") || !cfg.originStripped()) {
      return tokenError(400, "invalid_request", "AADSTS9002326: Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type.");
    }
    const form = new URLSearchParams(String(init.body || ""));
    const f = Object.fromEntries(form);
    entry.form = f;
    // TOKEN: public clients "must not use secrets or certificates".
    if (f.client_secret || f.client_assertion) return tokenError(401, "invalid_client", "AADSTS700025: Client is public so neither 'client_assertion' nor 'client_secret' should be presented.");
    if (!f.client_id) return tokenError(400, "invalid_request", "AADSTS900144: The request body must contain the following parameter: 'client_id'.");
    if (f.client_id !== cfg.clientId) return tokenError(400, "unauthorized_client", "AADSTS700016: Application not found.");
    if (f.grant_type === "refresh_token") {
      // TOKEN "Refresh the access token": client_id, grant_type, refresh_token required. scope is listed as
      // optional there; this fake requires it (WATnow always sends it) and checks it is a subset of the grant.
      if (!f.refresh_token) return tokenError(400, "invalid_request", "AADSTS900144: missing 'refresh_token'.");
      if (!f.scope) return tokenError(400, "invalid_request", "AADSTS900144: missing 'scope' (strict fake).");
      const rt = refreshTokens.get(f.refresh_token);
      if (!rt || rt.revoked) return tokenError(400, "invalid_grant", "AADSTS70000: The provided grant is invalid or malformed.");
      const asked = normScopes(f.scope);
      const granted = normScopes(rt.scope);
      if (asked.some((s) => !granted.includes(s))) return tokenError(400, "invalid_scope", "AADSTS70011: scope not a subset of the original grant.");
      // TOKEN: "A new OAuth 2.0 refresh token. Replace the old refresh token with this newly acquired refresh token."
      if (cfg.revokeRotatedRefreshTokens) rt.revoked = true;
      const out = issue(rt.accountId, rt.scope);
      entry.issued = out.refresh_token;
      return json(200, out);
    }
    if (f.grant_type === "authorization_code") {
      // TOKEN "Redeem a code": client_id, code, redirect_uri, grant_type required; code_verifier required with PKCE.
      for (const k of ["code", "redirect_uri", "code_verifier"]) if (!f[k]) return tokenError(400, "invalid_request", `AADSTS900144: missing '${k}'.`);
      const c = codes.get(f.code);
      if (!c || c.used) return tokenError(400, "invalid_grant", "AADSTS54005: OAuth2 Authorization code was already redeemed / invalid.");
      if (c.redirect !== f.redirect_uri) return tokenError(400, "invalid_grant", "AADSTS50148: redirect_uri mismatch.");
      if (b64url(createHash("sha256").update(f.code_verifier).digest()) !== c.challenge) return tokenError(400, "invalid_grant", "AADSTS501481: The Code_Verifier does not match the code_challenge.");
      c.used = true;
      const out = issue(c.accountId, c.scope);
      entry.issued = out.refresh_token;
      return json(200, out);
    }
    return tokenError(400, "unsupported_grant_type", "unsupported grant_type");
  }

  // ---------- Graph ----------
  function refuse(entry, status, code, message) {
    entry.status = status;
    entry.refused = `${code}: ${message}`;
    if (status === 400 || status === 405 || status === 415) violations.push({ i: entry.i, method: entry.method, url: entry.url, code, message });
    return json(status, { error: { code, message } });
  }

  function parseQuery(entry, raw) {
    // PAGING/EPGET: "Make sure you apply URL encoding to the following characters in the filter string -
    // colon, forward slash, and space." A raw space anywhere in a URL is invalid HTTP.
    const q = new Map();
    if (!raw) return q;
    for (const part of raw.split("&")) {
      const eq = part.indexOf("=");
      const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
      const rawV = eq < 0 ? "" : part.slice(eq + 1);
      if (q.has(k)) throw { status: 400, code: "BadRequest", message: `Query option '${k}' was specified more than once` };
      if (k === "$filter" && /[ :/]/.test(rawV)) throw { status: 400, code: "BadRequest", message: "$filter must URL-encode colon, slash and space" };
      if (k === "$expand" && / /.test(rawV)) throw { status: 400, code: "BadRequest", message: "$expand must URL-encode spaces" };
      q.set(k, decodeURIComponent(rawV));
    }
    return q;
  }

  function only(q, allowed) {
    for (const k of q.keys()) if (!allowed.includes(k)) throw { status: 400, code: "BadRequest", message: `Query option '${k}' is not allowed here` };
  }

  function select(q, props, type) {
    if (!q.has("$select")) return null;
    const fields = q.get("$select").split(",").map((s) => s.trim());
    for (const f of fields) {
      // The error real Graph gave for $select=id,calendarId.
      if (!props.has(f)) throw { status: 400, code: "RequestBroker--ParseUri", message: `Could not find a property named '${f}' on type 'microsoft.graph.${type}'.` };
    }
    return fields;
  }

  function top(q) {
    if (!q.has("$top")) return null;
    const n = Number(q.get("$top"));
    if (!Number.isInteger(n) || n < 1 || n > cfg.eventsMaxTop) throw { status: 400, code: "ErrorInvalidRequest", message: `Invalid $top ${q.get("$top")}` };
    return n;
  }

  function expandId(q) {
    if (!q.has("$expand")) return null;
    const m = EXPAND.exec(q.get("$expand"));
    if (!m) throw { status: 400, code: "BadRequest", message: `Unsupported $expand '${q.get("$expand")}'` };
    const id = unq(m[1]);
    if (!EP_ID.test(id)) throw { status: 400, code: "ErrorInvalidProperty", message: `Bad extended property id '${id}'` };
    return id;
  }

  function eventJson(ev, fields, expId) {
    const full = {
      "@odata.etag": `W/"${ev.changeKey}"`,
      id: ev.id,
      createdDateTime: ev.createdDateTime,
      lastModifiedDateTime: ev.lastModifiedDateTime,
      changeKey: ev.changeKey,
      categories: ev.categories || [],
      subject: ev.subject ?? "",
      body: ev.body,
      start: ev.start && { dateTime: ev.start.dateTime, timeZone: ev.start.timeZone },
      end: ev.end && { dateTime: ev.end.dateTime, timeZone: ev.end.timeZone },
      showAs: ev.showAs ?? "busy",
      isReminderOn: ev.isReminderOn ?? true,
      type: "singleInstance",
      // EVENT: "This property is only returned in a response payload if an app has set it."
      ...(ev.transactionId ? { transactionId: ev.transactionId } : {}),
    };
    // Graph always returns id, even when not selected.
    const out = fields ? Object.fromEntries([["id", ev.id], ...fields.filter((f) => f in full).map((f) => [f, full[f]])]) : full;
    // EPGET: a $filter on extended properties: "The response body doesn't include the extended property";
    // only $expand brings it back.
    if (expId && ev.ext.has(expId)) out.singleValueExtendedProperties = [{ id: expId, value: ev.ext.get(expId) }];
    return out;
  }

  function calendarJson(c, fields) {
    const full = { id: c.id, name: c.name, color: "auto", hexColor: "", isDefaultCalendar: !!c.isDefaultCalendar, canEdit: true, canShare: true, isRemovable: !c.isDefaultCalendar, changeKey: `ck-${c.id}` };
    return fields ? Object.fromEntries([["id", c.id], ...fields.filter((f) => f in full).map((f) => [f, full[f]])]) : full;
  }

  function page(entry, kind, items, size, fields, expId, accountId) {
    const first = items.slice(0, size);
    const rest = items.slice(size);
    const body = { value: first.map((x) => (kind === "event" ? eventJson(x, fields, expId) : calendarJson(x, fields))) };
    if (rest.length) {
      // PAGING: "Use the entire URL in the @odata.nextLink property ... Don't try to extract the $skiptoken"
      const tok = randomUUID();
      pages.set(tok, { kind, items: rest, size, fields, expId, accountId });
      body["@odata.nextLink"] = `${GRAPH}/me/${kind === "event" ? "events" : "calendars"}?$skiptoken=${tok}`;
    }
    entry.status = 200;
    return json(200, body);
  }

  function validateDateTimeTimeZone(v, name) {
    if (!v || typeof v !== "object") throw { code: "ErrorInvalidRequest", message: `${name} must be a dateTimeTimeZone` };
    for (const k of Object.keys(v)) if (!["dateTime", "timeZone"].includes(k)) throw { code: "RequestBodyRead", message: `Unknown property '${k}' on dateTimeTimeZone` };
    if (!DATE_TIME.test(String(v.dateTime))) throw { code: "ErrorInvalidRequest", message: `${name}.dateTime '${v.dateTime}' is not {date}T{time}` };
    if (!TIME_ZONES.has(v.timeZone)) throw { code: "ErrorTimeZoneNotSupportedException", message: `${name}.timeZone '${v.timeZone}'` };
  }

  function validateEventBody(body, mode, existing) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw { code: "BadRequest", message: "Empty Payload. JSON content expected." };
    const allowed = mode === "create" ? EVENT_CREATE_KEYS : EVENT_UPDATE_KEYS;
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) {
        const why = EVENT_PROPS.has(k) ? "is read-only or can't be updated" : "does not exist on type 'microsoft.graph.event'";
        throw { code: "RequestBodyRead", message: `The property '${k}' ${why}.` };
      }
    }
    if ("subject" in body && typeof body.subject !== "string") throw { code: "RequestBodyRead", message: "subject must be a string" };
    if ("body" in body) {
      // BODY: itemBody { contentType: text | html, content }
      const b = body.body;
      if (!b || typeof b !== "object") throw { code: "RequestBodyRead", message: "body must be an itemBody" };
      for (const k of Object.keys(b)) if (!["contentType", "content"].includes(k)) throw { code: "RequestBodyRead", message: `Unknown property '${k}' on itemBody` };
      if (!["text", "html"].includes(String(b.contentType).toLowerCase())) throw { code: "RequestBodyRead", message: `bad contentType '${b.contentType}'` };
      if (typeof b.content !== "string") throw { code: "RequestBodyRead", message: "content must be a string" };
    }
    if ("start" in body) validateDateTimeTimeZone(body.start, "start");
    if ("end" in body) validateDateTimeTimeZone(body.end, "end");
    if (mode === "create" && (!body.start || !body.end)) throw { code: "ErrorInvalidRequest", message: "start and end are needed" };
    const s = body.start || existing?.start;
    const e = body.end || existing?.end;
    // Assumption (not stated on the pages above): Outlook refuses an end before the start.
    if (s && e && s.timeZone === e.timeZone && Date.parse(e.dateTime + "Z") < Date.parse(s.dateTime + "Z")) throw { code: "ErrorInvalidRequest", message: "end is before start" };
    if ("showAs" in body && !SHOW_AS.has(body.showAs)) throw { code: "RequestBodyRead", message: `bad showAs '${body.showAs}'` };
    if ("isReminderOn" in body && typeof body.isReminderOn !== "boolean") throw { code: "RequestBodyRead", message: "isReminderOn must be a Boolean" };
    if ("categories" in body && (!Array.isArray(body.categories) || body.categories.some((c) => typeof c !== "string"))) throw { code: "RequestBodyRead", message: "categories must be strings" };
    if ("transactionId" in body) {
      if (typeof body.transactionId !== "string" || !body.transactionId) throw { code: "RequestBodyRead", message: "transactionId must be a string" };
      // EVENT: "After you set transactionId when creating an event, you can't change transactionId in a subsequent update."
      if (mode === "update" && body.transactionId !== existing.transactionId) throw { code: "ErrorInvalidRequest", message: "transactionId can't be changed" };
    }
    if ("singleValueExtendedProperties" in body) {
      const list = body.singleValueExtendedProperties;
      if (!Array.isArray(list)) throw { code: "RequestBodyRead", message: "singleValueExtendedProperties must be a collection" };
      for (const p of list) {
        // EPPOST: each entry has id (Required, a supported format) and value (Required).
        if (!p || typeof p !== "object") throw { code: "RequestBodyRead", message: "bad extended property" };
        for (const k of Object.keys(p)) if (!["id", "value"].includes(k)) throw { code: "RequestBodyRead", message: `Unknown property '${k}' on singleValueLegacyExtendedProperty` };
        if (!EP_ID.test(String(p.id))) throw { code: "ErrorInvalidProperty", message: `Bad extended property id '${p.id}'` };
        if (typeof p.value !== "string") throw { code: "RequestBodyRead", message: "extended property value must be a string" };
      }
    }
  }

  function storeEvent(ev, body) {
    for (const k of ["subject", "body", "showAs", "isReminderOn", "categories"]) if (k in body) ev[k] = structuredClone(body[k]);
    for (const k of ["start", "end"]) if (k in body) ev[k] = { dateTime: normDT(body[k].dateTime), timeZone: body[k].timeZone };
    for (const p of body.singleValueExtendedProperties || []) ev.ext.set(p.id, p.value);
    ev.lastModifiedDateTime = new Date().toISOString();
    ev.changeKey = `ck${++seq}`;
  }
  // Graph answers with seven fractional digits, e.g. "2019-03-15T12:00:00.0000000".
  const normDT = (s) => {
    const [d, t = "00:00"] = s.split("T");
    const [hms, frac = ""] = t.split(".");
    const parts = hms.split(":");
    while (parts.length < 3) parts.push("00");
    return `${d}T${parts.join(":")}.${frac.padEnd(7, "0")}`;
  };

  async function graphRequest(url, init) {
    const i = ++graphIndex;
    const method = init.method || "GET";
    const entry = { kind: "graph", i, method, url };
    log.push(entry);
    if (hooks.has(i)) await hooks.get(i)(entry);
    let fault = faults.get(i);
    if (!fault) {
      const rule = rules.find((r) => r.times > 0 && r.when(entry));
      if (rule) {
        rule.times--;
        fault = rule.fault;
      }
    }
    entry.fault = fault;
    // Fault injection that happens before Graph does anything.
    if (fault?.network) {
      entry.status = "network";
      throw new InjectedNetworkError("fetch failed");
    }
    if (fault?.status === 429 || fault?.status === 503) {
      entry.status = fault.status;
      // THROTTLE: "Returns HTTP status code 429 Too Many Requests ... Returns a suggested wait time" in Retry-After (seconds).
      return json(fault.status, { error: { code: fault.status === 429 ? "TooManyRequests" : "ServiceUnavailable", message: "Please retry again later." } }, fault.retryAfter != null ? { "Retry-After": String(fault.retryAfter) } : {});
    }
    if (/\s/.test(url)) return refuse(entry, 400, "BadRequest", "URL contains whitespace");
    if (!url.startsWith(GRAPH + "/")) return refuse(entry, 400, "BadRequest", "not a v1.0 URL");

    // Authorization: every Graph page above: "Authorization | Bearer {token}. Required."
    const auth = String(header(init, "Authorization") || "");
    const m = /^Bearer (\S+)$/.exec(auth);
    const at = m && accessTokens.get(m[1]);
    if (fault?.expireToken && at) at.revoked = true;
    if (!at || at.revoked || at.expiresAt <= Date.now()) {
      entry.status = 401;
      return json(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } });
    }
    const acct = accounts.get(at.accountId);
    entry.accountId = acct.id;

    const [rawPath, rawQuery = ""] = url.slice(GRAPH.length).split(/\?(.*)/s);
    const seg = rawPath.split("/").filter(Boolean).map(decodeURIComponent);
    let q;
    try {
      q = parseQuery(entry, rawQuery);
    } catch (e) {
      return refuse(entry, e.status || 400, e.code, e.message);
    }
    let body;
    if (method === "POST" || method === "PATCH") {
      // CREATE: "Content-Type | application/json. Required."
      if (!String(header(init, "Content-Type") || "").startsWith("application/json")) return refuse(entry, 415, "UnsupportedMediaType", "Content-Type must be application/json");
      try {
        body = JSON.parse(init.body);
      } catch {
        return refuse(entry, 400, "BadRequest", "Unable to read JSON request payload");
      }
      entry.body = body;
    }

    try {
      const res = route(entry, acct, method, seg, q, body);
      // Fault injection that happens AFTER Graph has done the work.
      if (fault?.commitThenDrop) {
        entry.committed = true;
        entry.status = "dropped";
        throw new InjectedNetworkError("fetch failed: socket hang up");
      }
      if (fault?.hideResults) {
        entry.hidden = true;
        return json(200, { value: [] });
      }
      if (fault?.commitThenBadBody) {
        entry.committed = true;
        return new Response("{\"id\":\"AAMk", { status: res.status, headers: { "Content-Type": "application/json" } });
      }
      return res;
    } catch (e) {
      if (e instanceof InjectedNetworkError) throw e;
      if (e instanceof Error) {
        // A bug in this fake, not in WATnow: make it fail the test loudly.
        violations.push({ i: entry.i, fakeBug: e.stack });
        throw e;
      }
      if (e.status && e.status !== 400) return refuse(entry, e.status, e.code, e.message);
      return refuse(entry, 400, e.code || "BadRequest", e.message || String(e));
    }
  }

  function route(entry, acct, method, seg, q, body) {
    if (seg[0] !== "me") throw { status: 400, code: "BadRequest", message: "Only /me is modelled" };
    // /me
    if (seg.length === 1 && method === "GET") {
      only(q, ["$select"]);
      const fields = select(q, USER_PROPS, "user");
      const full = { id: acct.id, displayName: acct.displayName, mail: acct.mail, userPrincipalName: acct.upn };
      entry.status = 200;
      return json(200, fields ? Object.fromEntries(fields.map((f) => [f, full[f] ?? null])) : full);
    }
    // /me/calendars
    if (seg[1] === "calendars" && seg.length === 2) {
      if (method === "GET") {
        if (q.has("$skiptoken")) return nextPage(entry, q, acct, "calendar");
        only(q, ["$select", "$top", "$filter"]);
        const fields = select(q, CALENDAR_PROPS, "calendar");
        const size = top(q) ?? cfg.calendarPageSize;
        return page(entry, "calendar", [...acct.calendars.values()], Math.min(size, cfg.calendarPageSize), fields, null, acct.id);
      }
      if (method === "POST") {
        for (const k of Object.keys(body || {})) if (!CALENDAR_CREATE_KEYS.has(k)) throw { code: "RequestBodyRead", message: `The property '${k}' can't be set on a new calendar.` };
        if (typeof body.name !== "string" || !body.name) throw { code: "ErrorInvalidRequest", message: "name is needed" };
        if (cfg.duplicateCalendarName === "409" && [...acct.calendars.values()].some((c) => c.name.toLowerCase() === body.name.toLowerCase())) {
          // Not documented on NEWCAL; Exchange answers ErrorFolderExists in practice. Configurable.
          throw { status: 409, code: "ErrorFolderExists", message: "A folder with the specified name already exists." };
        }
        const c = { id: `AAMkCal-${acct.id}-${++seq}=`, name: body.name };
        acct.calendars.set(c.id, c);
        entry.status = 201;
        entry.created = c.id;
        return json(201, calendarJson(c));
      }
    }
    // /me/calendars/{id}
    if (seg[1] === "calendars" && seg.length === 3) {
      const c = acct.calendars.get(seg[2]);
      if (!c) throw { status: 404, code: "ErrorItemNotFound", message: "The specified object was not found in the store." };
      if (method === "GET") {
        only(q, ["$select"]);
        entry.status = 200;
        return json(200, calendarJson(c, select(q, CALENDAR_PROPS, "calendar")));
      }
    }
    // /me/calendars/{id}/events
    if (seg[1] === "calendars" && seg.length === 4 && seg[3] === "events") {
      const c = acct.calendars.get(seg[2]);
      if (!c) throw { status: 404, code: "ErrorItemNotFound", message: "The specified object was not found in the store." };
      if (method === "POST") {
        only(q, []);
        validateEventBody(body, "create");
        if (body.transactionId && acct.txn.has(body.transactionId)) {
          const prior = acct.txn.get(body.transactionId);
          const live = acct.events.get(prior.id);
          if (live || cfg.transactionIdScope === "ever") {
            // EVENT: transactionId lets "the server ... avoid redundant POST operations in case of client retries".
            // The status of such a deduplicated create isn't documented; modelled as 201 with the first event.
            entry.status = 201;
            entry.deduped = prior.id;
            return json(201, eventJson(live || prior));
          }
        }
        const now = new Date().toISOString();
        const ev = { id: `AAMk-${acct.id}-${++seq}_e=`, calendarId: c.id, ext: new Map(), createdDateTime: now, transactionId: body.transactionId || null };
        storeEvent(ev, body);
        acct.events.set(ev.id, ev);
        if (ev.transactionId) acct.txn.set(ev.transactionId, ev);
        entry.status = 201;
        entry.created = ev.id;
        return json(201, eventJson(ev));
      }
      if (method === "GET") {
        if (q.has("$skiptoken")) return nextPage(entry, q, acct, "event");
        only(q, ["$select", "$top", "$expand"]);
        // EPGET: the Any() filter is documented on /me/events, not on one calendar's events: refuse it here.
        const fields = select(q, EVENT_PROPS, "event");
        const items = [...acct.events.values()].filter((e) => e.calendarId === c.id);
        return page(entry, "event", items, top(q) ?? 10, fields, expandId(q), acct.id);
      }
    }
    // /me/events
    if (seg[1] === "events" && seg.length === 2 && method === "GET") {
      if (q.has("$skiptoken")) return nextPage(entry, q, acct, "event");
      only(q, ["$filter", "$expand", "$select", "$top"]);
      const fields = select(q, EVENT_PROPS, "event");
      const expId = expandId(q);
      let items = [...acct.events.values()];
      if (q.has("$filter")) {
        const fm = FILTER.exec(q.get("$filter"));
        if (!fm) throw { code: "BadRequest", message: `Invalid filter clause '${q.get("$filter")}'` };
        const id = unq(fm[1]);
        if (!EP_ID.test(id)) throw { code: "ErrorInvalidProperty", message: `Bad extended property id '${id}'` };
        const op = fm[2] || fm[4];
        const want = unq(fm[3] ?? fm[5]).toLowerCase();
        // EPGET: "The filter is applied to all instances of the resource in the signed-in user's mailbox."
        // "Filtering the string name (Name) in the id ... is case-sensitive. Filtering the value ... is case-insensitive."
        items = items.filter((e) => {
          if (!e.ext.has(id)) return false;
          const v = e.ext.get(id).toLowerCase();
          return op === "eq" ? v === want : op === "ne" ? v !== want : op === "contains" ? v.includes(want) : v.startsWith(want);
        });
      }
      return page(entry, "event", items, top(q) ?? 10, fields, expId, acct.id);
    }
    // /me/events/{id}
    if (seg[1] === "events" && seg.length === 3) {
      const ev = acct.events.get(seg[2]);
      if (!ev) throw { status: 404, code: "ErrorItemNotFound", message: "The specified object was not found in the store." };
      if (method === "GET") {
        only(q, ["$select", "$expand"]);
        entry.status = 200;
        return json(200, eventJson(ev, select(q, EVENT_PROPS, "event"), expandId(q)));
      }
      if (method === "PATCH") {
        only(q, []);
        validateEventBody(body, "update", ev);
        storeEvent(ev, body);
        entry.status = 200;
        entry.patched = ev.id;
        return json(200, eventJson(ev));
      }
      if (method === "DELETE") {
        only(q, []);
        acct.events.delete(ev.id);
        entry.status = 204;
        entry.deleted = ev.id;
        return json(204);
      }
    }
    throw { status: 400, code: "BadRequest", message: `Resource not found for the segment '${seg.join("/")}' (${method})` };
  }

  function nextPage(entry, q, acct, kind) {
    only(q, ["$skiptoken"]);
    const p = pages.get(q.get("$skiptoken"));
    if (!p || p.accountId !== acct.id || p.kind !== kind) throw { code: "BadRequest", message: "Invalid $skiptoken" };
    pages.delete(q.get("$skiptoken"));
    return page(entry, kind, p.items, p.size, p.fields, p.expId, acct.id);
  }

  async function fetchImpl(input, init = {}) {
    const url = String(input);
    if (url.startsWith(TOKEN_URL)) return tokenEndpoint(url, init);
    if (url.startsWith("https://graph.microsoft.com/")) return graphRequest(url, init);
    throw new Error(`strict fake: unexpected fetch ${url}`);
  }

  // ---------- inspection helpers for tests ----------
  const graphLog = () => log.filter((e) => e.kind === "graph");
  const writes = (from = 0) => graphLog().filter((e) => e.i > from && ["POST", "PATCH", "DELETE"].includes(e.method));
  function calendarsNamed(accountId, name) {
    return [...accounts.get(accountId).calendars.values()].filter((c) => c.name === name);
  }
  function eventsIn(accountId, calendarId) {
    return [...accounts.get(accountId).events.values()].filter((e) => e.calendarId === calendarId);
  }

  return {
    cfg,
    fetch: fetchImpl,
    authorize,
    addAccount,
    seedRefreshToken,
    accounts,
    refreshTokens,
    accessTokens,
    log,
    violations,
    faults,
    hooks,
    /** Inject `fault` into the next `times` Graph requests that `when(entry)` picks. */
    faultWhen(when, fault, times = 1) {
      rules.push({ when, fault, times });
    },
    graphLog,
    writes,
    calendarsNamed,
    eventsIn,
    get graphIndex() {
      return graphIndex;
    },
    note(kind, data) {
      log.push({ kind, ...data });
    },
  };
}
