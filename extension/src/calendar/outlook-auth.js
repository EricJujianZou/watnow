// Microsoft sign-in for the Outlook calendar sync: authorization code + PKCE,
// as a public client with no secret. Never log tokens, codes or the sign-in URL.
//
// The access token lasts about an hour and stays in memory and session storage.
// The refresh token (and the account it belongs to) is kept in local extension
// storage under "outlookAuth": the sync runs for a whole term, so it has to
// survive browser restarts, and extension storage isn't readable by websites.
// Microsoft rotates refresh tokens, so the newest one is always saved.
import { calendarError } from "./google-auth.js";
import { GRAPH_BASE, OUTLOOK_CLIENT_ID, OUTLOOK_SCOPES, OUTLOOK_TENANT } from "./outlook-config.js";

const AUTH_KEY = "outlookAuth";
const SESSION_KEY = "outlookToken";
const ORIGIN_RULE_ID = 4242;
// Renew a little early so a request never starts with a token about to lapse.
const EARLY_REFRESH_MS = 2 * 60 * 1000;
const LOGIN_BASE = `https://login.microsoftonline.com/${OUTLOOK_TENANT}/oauth2/v2.0`;

const GENERIC_CONNECT_ERROR = "Outlook couldn't connect. Try again later.";
const RECONNECT = "Sign in to Outlook again to keep syncing.";
const ADMIN_APPROVAL = "Your school's Microsoft account needs an administrator's approval for WATnow. Try a personal Outlook account, or ask your school's IT.";

let clientId = OUTLOOK_CLIENT_ID;
let tokenMemory = null;
let refreshing = null;
let authEpoch = 0;
let interactiveAuth = false;

/** Test hooks only: the client ID is a constant in real builds. */
/** Whether this build can sign in to Microsoft (it has a client ID). */
export function outlookAuthConfigured() {
  return !!clientId;
}

export const __testing = {
  setClientId(id) {
    clientId = id;
  },
  reset() {
    clientId = OUTLOOK_CLIENT_ID;
    tokenMemory = null;
    refreshing = null;
    interactiveAuth = false;
    authEpoch++;
  },
};

export function outlookRedirectUrl() {
  return chrome.identity.getRedirectURL("outlook");
}

/** Microsoft refuses to redeem a desktop-app code when the request carries an
 * Origin header, and fetches from an extension always send one. This session
 * rule strips it, only for this extension's own requests to the token endpoint.
 * Without the API (or the host permission) we carry on and let Microsoft answer. */
export async function ensureOriginRule() {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  let initiator = chrome.runtime.id;
  try {
    // Firefox's extension origin is a per-install UUID, not the add-on ID.
    initiator = new URL(chrome.runtime.getURL("")).hostname || initiator;
  } catch {}
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [ORIGIN_RULE_ID],
      addRules: [
        {
          id: ORIGIN_RULE_ID,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
          condition: {
            regexFilter: "^https://login\\.microsoftonline\\.com/[^/]+/oauth2/v2\\.0/token",
            resourceTypes: ["xmlhttprequest", "other"],
            initiatorDomains: [initiator],
          },
        },
      ],
    });
  } catch (e) {
    console.warn("WATnow couldn't set up the Microsoft sign-in rule:", e?.message || e);
  }
}

async function removeOriginRule() {
  try {
    await chrome.declarativeNetRequest?.updateSessionRules?.({ removeRuleIds: [ORIGIN_RULE_ID] });
  } catch {}
}

async function getSessionToken() {
  if (tokenMemory) return tokenMemory;
  try {
    const { [SESSION_KEY]: saved } = await chrome.storage.session.get(SESSION_KEY);
    if (saved?.token) tokenMemory = saved;
  } catch {
    /* session storage unavailable */
  }
  return tokenMemory;
}

async function setSessionToken(tokenData) {
  tokenMemory = tokenData;
  try {
    if (tokenData) await chrome.storage.session.set({ [SESSION_KEY]: tokenData });
    else await chrome.storage.session.remove(SESSION_KEY);
  } catch {
    /* session storage unavailable */
  }
}

async function getSavedAuth() {
  const { [AUTH_KEY]: saved } = await chrome.storage.local.get(AUTH_KEY);
  return saved && saved.refreshToken && saved.account ? saved : null;
}

function base64url(bytes) {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Consent a school's admin has to grant: AADSTS65001 (consent needed),
 * 90094 / 90095 (admin approval required). Students can't fix these themselves. */
function needsAdmin(code, description) {
  const text = String(description || "");
  return code === "consent_required" || /AADSTS(65001|90094|90095)\b/.test(text) || /admin(istrator)? (approval|consent)/i.test(text);
}

/** Translate launchWebAuthFlow failures; keep student-facing messages clean and clear. */
function authorizationError(error) {
  const rawMessage = String(typeof error === "string" ? error : error?.message || error?.name || "");
  const message = rawMessage.toLowerCase();

  if (message.includes("only one web auth flow") || message.includes("auth flow is already")) {
    return calendarError("auth", "A Microsoft sign-in window is already open. Finish or close it before trying again.");
  }
  if (message.includes("couldn't create a browser window") || message.includes("incognito")) {
    return calendarError("auth", "Connect Outlook from a regular browser window.");
  }
  // Chrome says "did not approve access"; Firefox says "User cancelled or denied access."
  if (message.includes("did not approve access") || message.includes("cancel") || message.includes("denied") || message.includes("closed")) {
    return calendarError("cancelled", "Microsoft sign-in was closed before it finished.");
  }
  if (message.includes("timed out")) {
    return calendarError("network", "Microsoft's sign-in page took too long to load. Try again.", true);
  }

  console.warn("Microsoft authorization error:", rawMessage);
  return calendarError("auth", GENERIC_CONNECT_ERROR);
}

/** An error=... sent back to the redirect URL instead of a code. */
function consentError(code, description) {
  if (needsAdmin(code, description)) return calendarError("auth", ADMIN_APPROVAL);
  if (code === "access_denied") return calendarError("cancelled", "Microsoft sign-in was closed before it finished.");
  if (["invalid_client", "unauthorized_client", "invalid_request", "invalid_scope", "unsupported_response_type"].includes(code)) {
    console.warn("WATnow Microsoft sign-in configuration error:", code);
    return calendarError("configuration", GENERIC_CONNECT_ERROR);
  }
  return calendarError("auth", GENERIC_CONNECT_ERROR);
}

/** POSTs to the token endpoint; resolves to its JSON or throws a calendarError. */
async function tokenRequest(fields, interactive) {
  await ensureOriginRule();
  let res;
  try {
    res = await fetch(`${LOGIN_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: OUTLOOK_SCOPES.join(" "), ...fields }).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw calendarError("network", "Couldn't reach Microsoft. We'll try again.", true);
  }
  let body = {};
  try {
    body = await res.json();
  } catch {}
  if (res.ok && body.access_token) return body;
  if (res.status === 429 || res.status >= 500) {
    throw calendarError("network", "Microsoft is busy right now. We'll try again.", true);
  }
  const code = body.error || "";
  if (needsAdmin(code, body.error_description)) throw calendarError("auth", ADMIN_APPROVAL);
  if (code === "invalid_grant" || code === "interaction_required") {
    // A code that expired in transit, or a refresh token that was revoked,
    // expired after 90 idle days, or died with a password change.
    throw calendarError("auth", interactive ? "Microsoft didn't finish connecting. Try again." : RECONNECT);
  }
  if (["invalid_client", "unauthorized_client", "invalid_scope", "invalid_request"].includes(code)) {
    // Description is Microsoft's text about our setup; it carries no token.
    console.warn("WATnow Microsoft token configuration error:", code, String(body.error_description || "").split("\n")[0]);
    throw calendarError("configuration", GENERIC_CONNECT_ERROR);
  }
  throw calendarError("auth", interactive ? GENERIC_CONNECT_ERROR : RECONNECT);
}

/** Checks the grant covers the calendar and is usable; returns session token data. */
function readTokens(body, accountId) {
  const seconds = Number(body.expires_in);
  if (String(body.token_type || "bearer").toLowerCase() !== "bearer" || !Number.isFinite(seconds) || seconds <= 0) {
    throw calendarError("auth", "Microsoft didn't return a valid sign-in. Connect again to try again.");
  }
  // Microsoft may answer with full URIs ("https://graph.microsoft.com/Calendars.ReadWrite").
  const granted = String(body.scope || "").toLowerCase().split(/\s+/).map((s) => s.split("/").pop());
  if (body.scope && !granted.includes("calendars.readwrite")) {
    throw calendarError("auth", "Allow WATnow to use your Outlook calendar to sync deadlines.");
  }
  return { token: body.access_token, accountId, expiresAt: Date.now() + seconds * 1000 };
}

async function identify(token) {
  let res;
  try {
    res = await fetch(`${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw calendarError("network", "Couldn't reach Microsoft. We'll try again.", true);
  }
  if (res.status === 401) throw calendarError("auth", "Microsoft didn't finish connecting. Try again.");
  if (!res.ok) throw calendarError("network", "Microsoft couldn't confirm the account. Try again.", true);
  const me = await res.json();
  const email = me.mail || me.userPrincipalName;
  if (!me.id || !email) throw calendarError("auth", "Microsoft didn't confirm an email address. Connect again to try again.");
  return { id: me.id, email, name: me.displayName || "" };
}

/** Called only after an explicit Connect click, with the email the student typed. */
export async function connectOutlook({ email } = {}) {
  if (!clientId) throw calendarError("configuration", "Outlook sync isn't set up in this version of WATnow.");
  if (interactiveAuth) throw calendarError("auth", "A Microsoft sign-in window is still open. Finish or close it before trying again.");
  interactiveAuth = true;
  const epoch = ++authEpoch;
  const cancelled = () => calendarError("cancelled", "Connection cancelled.");
  try {
    const redirect = outlookRedirectUrl();
    const state = crypto.randomUUID();
    const { verifier, challenge } = await pkcePair();
    const url = new URL(`${LOGIN_BASE}/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      response_mode: "query",
      scope: OUTLOOK_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(email ? { login_hint: String(email).trim() } : {}),
      prompt: "select_account",
    }).toString();

    let response;
    try {
      response = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    } catch (e) {
      if (epoch !== authEpoch) throw cancelled();
      throw authorizationError(e);
    }
    if (epoch !== authEpoch) throw cancelled();
    let returned;
    try {
      returned = new URL(response);
    } catch {
      throw calendarError("auth", "Microsoft didn't finish connecting. Try again.");
    }
    const expected = new URL(redirect);
    const params = returned.searchParams;
    if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || params.get("state") !== state) {
      throw calendarError("auth", "Microsoft's response couldn't be verified. Try connecting again.");
    }
    if (params.has("error")) throw consentError(params.get("error"), params.get("error_description"));
    const code = params.get("code");
    if (!code) throw calendarError("auth", "Microsoft didn't finish connecting. Try again.");

    const body = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }, true);
    if (!body.refresh_token) throw calendarError("auth", "Microsoft didn't allow staying signed in. Connect again to try again.");
    const tokens = readTokens(body, null);
    const account = await identify(tokens.token);
    if (epoch !== authEpoch) throw cancelled();
    await chrome.storage.local.set({ [AUTH_KEY]: { refreshToken: body.refresh_token, account, scope: body.scope || OUTLOOK_SCOPES.join(" ") } });
    await setSessionToken({ ...tokens, accountId: account.id });
    return { account };
  } finally {
    interactiveAuth = false;
  }
}

async function refresh(account) {
  const epoch = authEpoch;
  const saved = await getSavedAuth();
  if (!saved || saved.account.id !== account.id) throw calendarError("auth", RECONNECT);
  const body = await tokenRequest({ grant_type: "refresh_token", refresh_token: saved.refreshToken }, false);
  const tokens = readTokens(body, account.id);
  // Disconnected meanwhile: don't bring the sign-in back.
  if (epoch !== authEpoch) throw calendarError("cancelled", "Connection cancelled.");
  await chrome.storage.local.set({
    [AUTH_KEY]: { ...saved, refreshToken: body.refresh_token || saved.refreshToken, scope: body.scope || saved.scope },
  });
  // A disconnect (or Delete my data) may have run while the write above was
  // pending: then this token mustn't be kept.
  if (epoch !== authEpoch) {
    await chrome.storage.local.remove(AUTH_KEY).catch(() => {});
    throw calendarError("cancelled", "Connection cancelled.");
  }
  await setSessionToken(tokens);
  return tokens.token;
}

/** An access token for `account`, renewed silently with the saved refresh token. */
export async function getOutlookToken(account) {
  if (!account?.id) throw calendarError("auth", RECONNECT);
  const saved = await getSavedAuth();
  if (!saved || saved.account.id !== account.id) throw calendarError("auth", RECONNECT);
  const cached = await getSessionToken();
  if (cached?.accountId === account.id && cached.expiresAt - Date.now() > EARLY_REFRESH_MS) return cached.token;
  // One refresh at a time: with rotation, two at once would race to save.
  if (!refreshing) {
    refreshing = refresh(account).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** Drops the access token (Graph answered 401) but keeps the refresh token,
 * so the next getOutlookToken() fetches a fresh one. */
export async function invalidateOutlookToken() {
  await setSessionToken(null);
}

/** Forgets the Microsoft sign-in. Events already in Outlook stay. */
export async function disconnectOutlook() {
  authEpoch++;
  refreshing = null;
  await setSessionToken(null);
  try {
    await chrome.storage.local.remove(AUTH_KEY);
  } catch {}
  await removeOriginRule();
}
