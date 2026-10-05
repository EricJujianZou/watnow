/*
  Google Calendar, as one of the calendars src/calendar/events.js plans for.

  WATnow makes a secondary calendar of its own ("WATnow deadlines") and works
  only inside it. The scope is calendar.app.created, which reaches nothing else
  in the student's Google account: not their other calendars, not the events on
  them. Taking the connection away deletes that one calendar and nothing else.

  Signing in
    identity.launchWebAuthFlow with the authorization code flow and PKCE.
    getAuthToken is not used: Chrome has it and Gecko does not, and it ties the
    sign-in to a Chrome profile. PKCE means the code can only be redeemed by
    the browser that started the sign-in, which is what matters here, since the
    client secret Google issues for an installed app is readable by anyone who
    has the extension (see google-config.js).

  The redirect address
    Chrome gives every install of an extension the same one,
    https://<extension-id>.chromiumapp.org/, so it can be registered with
    Google once. Gecko gives each *install* its own,
    https://<uuid>.extensions.allizom.org/, and Google only redirects to
    addresses registered beforehand, so a Gecko install cannot be registered.
    The way round it is a page of yours that Google does redirect to, which
    sends the browser on to whatever address the extension asked for, carried
    in `state`. Set GOOGLE_BOUNCE_URL to that page and Gecko uses it.
    Without one, connecting on Gecko is refused with a reason rather than
    failing at Google, and the calendar file export still covers that case.

  Tokens
    Kept in chrome.storage.local on this computer, like everything else WATnow
    saves. The access token is refreshed when it is within a minute of running
    out; a refresh that Google rejects clears the connection, so the student is
    asked to connect again instead of every sync quietly failing.

  Writing
    An event WATnow creates has its Google id written into the sync index, so
    the next change updates that event rather than making another. A deadline
    that disappears deletes its event. A 404 or 410 on update or delete means
    the student removed it themselves, which is not an error worth stopping for.
*/

import {
  GOOGLE_API,
  GOOGLE_AUTH_URL,
  GOOGLE_BOUNCE_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REVOKE_URL,
  GOOGLE_SCOPE,
  GOOGLE_TOKEN_URL,
  googleConfigured,
} from "./google-config.js";
import { CALENDAR_NAME } from "./events.js";
import { IS_GECKO } from "../core/env.js";

export { googleConfigured };

const AUTH_KEY = "googleAuth";
const EARLY_MS = 60 * 1000;
const TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------ */
/* PKCE                                                                */
/* ------------------------------------------------------------------ */

const B64URL = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 43 to 128 characters of the allowed set, per RFC 7636. */
export function makeVerifier() {
  return B64URL(crypto.getRandomValues(new Uint8Array(64)));
}

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return B64URL(digest);
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                             */
/* ------------------------------------------------------------------ */

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Where Google sends the browser back to.
 *
 * On Gecko the extension's own address is different for every install, so it
 * cannot be registered with Google; the bounce page stands in for it and
 * forwards to the real one.
 */
export function redirectUri() {
  const own = chrome.identity.getRedirectURL();
  if (IS_GECKO && GOOGLE_BOUNCE_URL) return GOOGLE_BOUNCE_URL;
  return own;
}

/**
 * The address the sign-in starts at.
 * @param {string} challenge  From challengeFor()
 * @param {string} redirect   What Google will send the browser back to
 * @param {string} [state]    Carries the extension's own address when a bounce page is used
 */
export function buildAuthUrl(challenge, redirect, state = "") {
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // offline plus consent is what makes Google hand back a refresh token, so
    // the 30 minute check can keep working without asking again every hour.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  if (state) q.set("state", state);
  return `${GOOGLE_AUTH_URL}?${q}`;
}

/**
 * The authorization code out of whatever Google redirected to.
 *
 * Both the query and the fragment are read, and both are checked for an error
 * before a code is looked for. Choosing Cancel at Google's consent screen comes
 * back as error=access_denied with no code at all, and that should say it was
 * refused rather than that something went missing.
 */
export function codeFromRedirect(url) {
  const u = new URL(url);
  const query = u.searchParams;
  const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
  const get = (key) => query.get(key) || hash.get(key);
  const error = get("error");
  if (error) throw fail("refused", `Google said: ${error}`);
  const code = get("code");
  if (!code) throw fail("no-code", "Google sent no authorization code back.");
  return code;
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  if (!res.ok) throw fail(res.status === 400 || res.status === 401 ? "rejected" : "unreachable", (json && (json.error_description || json.error)) || `Google returned ${res.status}`);
  return json;
}

/** Swaps the code for tokens and saves them. */
async function exchange(code, verifier, redirect) {
  const t = await postForm(GOOGLE_TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  if (!t.access_token) throw fail("rejected", "Google sent no access token back.");
  const auth = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || null,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    calendarId: null,
  };
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  return auth;
}

/**
 * Connects Google Calendar. Must be called straight from a click: the sign-in
 * window needs a user action behind it.
 */
export async function connectGoogle() {
  if (!googleConfigured()) throw fail("not-configured", "This build has no Google client set up.");
  const own = chrome.identity.getRedirectURL();
  const redirect = redirectUri();
  if (IS_GECKO && !GOOGLE_BOUNCE_URL) {
    throw fail("no-bounce", "This browser gives every install its own sign-in address, which Google will not accept. Export a calendar file instead.");
  }
  const verifier = makeVerifier();
  const challenge = await challengeFor(verifier);
  // On a bounce the page is told where to send the browser next.
  const url = buildAuthUrl(challenge, redirect, redirect === own ? "" : own);
  let back;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (e) {
    throw fail("cancelled", String((e && e.message) || e));
  }
  if (!back) throw fail("cancelled", "The sign-in was closed before it finished.");
  return exchange(codeFromRedirect(back), verifier, redirect);
}

export async function googleConnected() {
  if (!googleConfigured()) return false;
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  return Boolean(auth && (auth.refreshToken || auth.accessToken));
}

/**
 * Takes the WATnow calendar out of Google, forgets the tokens, and tells Google
 * to drop them too.
 *
 * The calendar goes first, while there is still a token to do it with. Leaving
 * it behind would leave a calendar that looks current and silently stops being
 * so. It only ever held WATnow's own events, and the scope cannot reach any
 * other calendar, so nothing else in the account is touched.
 */
export async function disconnectGoogle() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  if (auth && auth.calendarId) {
    try {
      await api(`/calendars/${encodeURIComponent(auth.calendarId)}`, { method: "DELETE" });
    } catch {
      // Already deleted by hand, or Google is unreachable. Disconnecting carries on.
    }
  }
  const token = auth && (auth.refreshToken || auth.accessToken);
  await chrome.storage.local.remove(AUTH_KEY);
  if (!token) return;
  try {
    await postForm(GOOGLE_REVOKE_URL, { token });
  } catch {
    // Already gone, or Google is unreachable. The tokens are off this computer either way.
  }
}

/** A usable access token, refreshed when it is nearly out. */
export async function accessToken() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  if (!auth) throw fail("not-connected", "Google Calendar isn't connected.");
  if (auth.accessToken && auth.expiresAt - EARLY_MS > Date.now()) return auth.accessToken;
  if (!auth.refreshToken) throw fail("not-connected", "The Google sign-in ran out and there is nothing to renew it with.");
  let t;
  try {
    t = await postForm(GOOGLE_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    });
  } catch (e) {
    // Access taken back from the Google account, or the token expired for good.
    if (e.code === "rejected") {
      await chrome.storage.local.remove(AUTH_KEY);
      throw fail("not-connected", "Google ended the connection. Connect it again to keep the calendar up to date.");
    }
    throw e;
  }
  const next = { ...auth, accessToken: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  await chrome.storage.local.set({ [AUTH_KEY]: next });
  return next.accessToken;
}

/* ------------------------------------------------------------------ */
/* The calendar                                                        */
/* ------------------------------------------------------------------ */

async function api(path, { method = "GET", body } = {}) {
  const token = await accessToken();
  const res = await fetch(`${GOOGLE_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 204) return null;
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const e = fail(res.status === 401 || res.status === 403 ? "not-connected" : res.status === 404 || res.status === 410 ? "gone" : "unreachable", (json && json.error && json.error.message) || `Google returned ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

/** The id of WATnow's own calendar, making it the first time. */
export async function ensureCalendar() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  if (!auth) throw fail("not-connected", "Google Calendar isn't connected.");
  if (auth.calendarId) return auth.calendarId;
  const made = await api("/calendars", { method: "POST", body: { summary: CALENDAR_NAME, description: "Deadlines WATnow read from Learn and Crowdmark." } });
  const id = made && made.id;
  if (!id) throw fail("unreachable", "Google made no calendar.");
  await chrome.storage.local.set({ [AUTH_KEY]: { ...auth, calendarId: id } });
  return id;
}

/** One of our events in the shape Google wants. */
export function toGoogleEvent(ev) {
  return {
    summary: ev.title,
    description: ev.description,
    start: { dateTime: new Date(ev.start).toISOString() },
    end: { dateTime: new Date(ev.end).toISOString() },
    source: ev.url ? { title: "Open in WATnow", url: ev.url } : undefined,
    iCalUID: ev.uid,
    transparency: "transparent",
    // The extension sends its own reminders; Google adding more would double them up.
    reminders: { useDefault: false, overrides: [] },
  };
}

/**
 * Carries out a plan from planSync.
 *
 * Returns the index to save: the same one planSync worked out, with the Google
 * id of each event written in, so the next run can change the right one.
 *
 * @param {{creates: Array, updates: Array, deletes: Array, index: object}} plan
 */
export async function applyPlan(plan) {
  const calendarId = await ensureCalendar();
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const index = { ...plan.index };
  const result = { added: 0, changed: 0, removed: 0, failed: 0 };

  for (const ev of plan.creates) {
    try {
      const made = await api(base, { method: "POST", body: toGoogleEvent(ev) });
      if (made && made.id) index[ev.uid] = { ...index[ev.uid], eventId: made.id };
      result.added += 1;
    } catch (e) {
      if (e.code === "not-connected") throw e;
      result.failed += 1;
    }
  }

  for (const ev of plan.updates) {
    try {
      if (!ev.eventId) {
        const made = await api(base, { method: "POST", body: toGoogleEvent(ev) });
        if (made && made.id) index[ev.uid] = { ...index[ev.uid], eventId: made.id };
      } else {
        await api(`${base}/${encodeURIComponent(ev.eventId)}`, { method: "PUT", body: toGoogleEvent(ev) });
      }
      result.changed += 1;
    } catch (e) {
      if (e.code === "not-connected") throw e;
      // Deleted from Google by hand: make it again next time rather than updating nothing.
      if (e.code === "gone") index[ev.uid] = { ...index[ev.uid], eventId: null };
      else result.failed += 1;
    }
  }

  for (const ev of plan.deletes) {
    if (!ev.eventId) continue;
    try {
      await api(`${base}/${encodeURIComponent(ev.eventId)}`, { method: "DELETE" });
      result.removed += 1;
    } catch (e) {
      if (e.code === "not-connected") throw e;
      // Already gone is the outcome we wanted.
      if (e.code !== "gone") result.failed += 1;
    }
  }

  return { index, result };
}
