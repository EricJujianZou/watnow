// Native tokens belong to Chrome; web-flow tokens stay only in browser session memory.
// Never save tokens or authorization URLs in persistent local storage or debug reports.
import { GOOGLE_SCOPES, GOOGLE_WEB_CLIENT_ID, googleConfigured } from "./config.js";

const GENERIC_CONNECT_ERROR = "Google Calendar couldn't connect. Try again later.";
let webTokenMemory = null;
let authEpoch = 0;
let interactiveAuth = false;

export function calendarError(code, message, retry = false) {
  return Object.assign(new Error(message), { code, retry });
}

async function getSessionWebToken() {
  if (webTokenMemory && webTokenMemory.expiresAt > Date.now()) return webTokenMemory;
  try {
    const { googleWebToken } = await chrome.storage.session.get("googleWebToken");
    if (googleWebToken && googleWebToken.expiresAt > Date.now()) {
      webTokenMemory = googleWebToken;
      return webTokenMemory;
    }
  } catch {
    /* session storage unavailable */
  }
  return null;
}

async function setSessionWebToken(tokenData) {
  webTokenMemory = tokenData;
  try {
    if (tokenData) await chrome.storage.session.set({ googleWebToken: tokenData });
    else await chrome.storage.session.remove("googleWebToken");
  } catch {
    /* session storage unavailable */
  }
}

/** Translate known errors; keep student-facing messages clean and clear. */
function authorizationError(error, interactive) {
  if (!interactive) return calendarError("auth", "Reconnect Google Calendar to continue syncing.");
  const rawMessage = String(typeof error === "string" ? error : error?.message || error?.name || "");
  const message = rawMessage.toLowerCase();

  // Log configuration or runtime details to the developer console
  if (message.includes("invalid oauth2 client id") || message.includes("invalid oauth2 scopes") || message.includes("bad client id")) {
    console.warn("WATnow Google Calendar configuration issue:", rawMessage);
    return calendarError("configuration", GENERIC_CONNECT_ERROR);
  }

  if (message.includes("only one web auth flow") || message.includes("auth flow is already")) {
    return calendarError("auth", "A Google sign-in window is already open. Finish or close it before trying again.");
  }
  if (message.includes("couldn't create a browser window") || message.includes("incognito")) {
    return calendarError("auth", "Connect Google Calendar from a regular Chrome window.");
  }
  if (message.includes("did not approve access") || message === "canceled" || message === "cancelled" || message.includes("closed")) {
    return calendarError("cancelled", "Google sign-in was closed before it finished.");
  }
  if (message.includes("page load timed out") || message.includes("timed out")) {
    return calendarError("network", "Google's sign-in page took too long to load. Try again.", true);
  }

  console.warn("Chrome authorization error:", rawMessage);
  return calendarError("auth", GENERIC_CONNECT_ERROR);
}

function consentError(code, interactive) {
  if (!interactive) return calendarError("auth", "Reconnect Google Calendar to continue syncing.");
  if (code === "access_denied") {
    return calendarError("cancelled", "Google sign-in was closed before it finished.");
  }
  // Configuration issues log to console; students get a friendly note
  if (["invalid_client", "invalid_scope", "redirect_uri_mismatch", "org_internal", "admin_policy_enforced"].includes(code)) {
    console.warn("WATnow OAuth consent configuration error:", code);
    return calendarError("configuration", GENERIC_CONNECT_ERROR);
  }
  return calendarError("auth", GENERIC_CONNECT_ERROR);
}

async function identify(token) {
  let res;
  try {
    res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw calendarError("network", "Couldn't reach Google. We'll try again.", true);
  }
  if (res.status === 401) {
    await invalidateGoogleToken(token);
    throw calendarError("auth", "Reconnect Google Calendar to continue syncing.");
  }
  if (!res.ok) throw calendarError("network", "Google couldn't confirm the account. Try again.", true);
  const user = await res.json();
  if (!user.sub || !user.email) throw calendarError("auth", "Google didn't confirm an email address. Reconnect to try again.");
  return { id: user.sub, email: user.email };
}

async function authorize({ interactive, account }) {
  if (!googleConfigured()) throw calendarError("configuration", GENERIC_CONNECT_ERROR);
  let result;
  try {
    result = await chrome.identity.getAuthToken({
      interactive,
      enableGranularPermissions: true,
      scopes: GOOGLE_SCOPES,
      ...(account ? { account: { id: account.id } } : {}),
    });
  } catch (e) {
    throw authorizationError(e, interactive);
  }
  if (!result.token || !GOOGLE_SCOPES.every((s) => result.grantedScopes?.includes(s))) {
    if (result.token) await chrome.identity.removeCachedAuthToken({ token: result.token });
    throw calendarError("auth", "Allow the requested Google Calendar permissions to sync deadlines.");
  }
  const selected = await identify(result.token);
  if (account && selected.id !== account.id) throw calendarError("auth", "Google returned a different account. Reconnect to choose where your deadlines go.");
  return { token: result.token, account: selected };
}

/** Web OAuth can explicitly request account selection; getAuthToken cannot.
 * Silent renewal is pinned to the verified Google subject. If interaction is
 * needed, background sync stays queued rather than failing permanently. */
async function authorizeWeb({ interactive, account }) {
  if (!GOOGLE_WEB_CLIENT_ID) throw calendarError("configuration", GENERIC_CONNECT_ERROR);
  const epoch = authEpoch;
  const state = crypto.randomUUID();
  const redirect = chrome.identity.getRedirectURL("google");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: GOOGLE_WEB_CLIENT_ID,
    redirect_uri: redirect,
    response_type: "token",
    scope: GOOGLE_SCOPES.join(" "),
    state,
    prompt: interactive ? "select_account" : "none",
    ...(account ? { login_hint: account.id } : {}),
  }).toString();
  let response;
  try {
    response = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch (e) {
    if (epoch !== authEpoch) throw calendarError("cancelled", "Connection cancelled.");
    throw authorizationError(e, interactive);
  }
  if (epoch !== authEpoch) throw calendarError("cancelled", "Connection cancelled.");
  let returned;
  try {
    returned = new URL(response);
  } catch {
    throw calendarError("auth", "Google didn't finish connecting. Try again.");
  }
  const expected = new URL(redirect);
  const params = new URLSearchParams(returned.hash.slice(1));
  if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || returned.search || params.get("state") !== state) {
    throw calendarError("auth", "Google's response couldn't be verified. Try connecting again.");
  }
  if (params.has("error")) throw consentError(params.get("error"), interactive);
  const token = params.get("access_token");
  const scopes = new Set((params.get("scope") || "").split(/\s+/));
  if (scopes.has("email")) scopes.add("https://www.googleapis.com/auth/userinfo.email");
  const seconds = Number(params.get("expires_in"));
  if (!token || params.get("token_type")?.toLowerCase() !== "bearer" || !Number.isFinite(seconds) || seconds <= 0) {
    throw calendarError("auth", "Google didn't return a valid authorization. Reconnect to try again.");
  }
  if (!GOOGLE_SCOPES.every((s) => scopes.has(s))) throw calendarError("auth", "Allow the requested Google Calendar permissions to sync deadlines.");
  const selected = await identify(token);
  if (epoch !== authEpoch) throw calendarError("cancelled", "Connection cancelled.");
  if (account && selected.id !== account.id) throw calendarError("auth", "Google returned a different account. Reconnect to choose where your deadlines go.");

  const tokenData = { token, accountId: selected.id, expiresAt: Date.now() + seconds * 1000 - 60000 };
  await setSessionWebToken(tokenData);
  return { token, account: { ...selected, auth: "web" } };
}

/** Called only after an explicit Connect / Change account click. */
export async function connectGoogle() {
  if (!googleConfigured()) throw calendarError("configuration", GENERIC_CONNECT_ERROR);
  if (interactiveAuth) throw calendarError("auth", "A Google sign-in window is still open. Finish or close it before trying again.");
  interactiveAuth = true;
  authEpoch++;
  await setSessionWebToken(null);
  try {
    if (GOOGLE_WEB_CLIENT_ID) return await authorizeWeb({ interactive: true });
    await chrome.identity.clearAllCachedAuthTokens();
    return await authorize({ interactive: true });
  } finally {
    interactiveAuth = false;
  }
}

export async function getGoogleToken(account) {
  if (account.auth === "web") {
    const cached = await getSessionWebToken();
    if (cached?.accountId === account.id && cached.expiresAt > Date.now()) return cached.token;
    return (await authorizeWeb({ interactive: false, account })).token;
  }
  return (await authorize({ interactive: false, account })).token;
}

export async function invalidateGoogleToken(token) {
  const cached = await getSessionWebToken();
  if (cached?.token === token) await setSessionWebToken(null);
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {}
}

export async function disconnectGoogle() {
  authEpoch++;
  await setSessionWebToken(null);
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch {}
}
