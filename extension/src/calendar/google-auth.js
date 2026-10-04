// Native tokens belong to Chrome; web-flow tokens stay only in worker memory.
// Never save tokens or authorization URLs in local storage or debug reports.
import { GOOGLE_SCOPES, GOOGLE_WEB_CLIENT_ID, googleConfigured } from "./config.js";

let webToken = null;
let authEpoch = 0;
let interactiveAuth = false;

export function calendarError(code, message, retry = false) {
  return Object.assign(new Error(message), { code, retry });
}

/** Keep unfamiliar Chrome errors useful without including URLs or credentials.
 * This is only for API exceptions, never an OAuth response or token payload. */
function browserErrorDetail(error) {
  return String(typeof error === "string" ? error : error?.message || error?.name || "No reason supplied by Chrome.")
    .replace(/(?:https?|chrome-extension):\/\/[^\s<>"']+/gi, "[URL removed]")
    .replace(/\b(?:access_token|refresh_token|id_token|client_secret|authorization|code|state)\b["']?\s*[:=]\s*["']?[^\s,;&"']+/gi, "[credential removed]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [removed]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email removed]")
    .replace(/[A-Za-z0-9_./+=-]{32,}/g, "[identifier removed]")
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Translate known errors; keep a sanitized Chrome reason for unknown ones. */
function authorizationError(error, interactive) {
  if (!interactive) return calendarError("auth", "Reconnect Google Calendar to continue syncing.");
  const message = String(typeof error === "string" ? error : error?.message || "").toLowerCase();
  if (message.includes("only one web auth flow") || message.includes("auth flow is already")) {
    return calendarError("auth", "A Google sign-in window is already open. Finish or close it before trying again. If you can't find it, reload WATnow in chrome://extensions.");
  }
  if (message.includes("couldn't create a browser window")) {
    return calendarError("auth", "Chrome couldn't open the Google sign-in window. Open a regular Chrome window and try Connect again.");
  }
  if (message.includes("page load timed out")) return calendarError("auth", "Google's sign-in page took too long to load. Check your connection and try again.");
  if (message.includes("browser context has been shut down")) return calendarError("auth", "Chrome closed the sign-in session. Reopen WATnow and try Connect again.");
  if (message.includes("did not approve access") || message === "canceled" || message === "cancelled") {
    return calendarError("auth", "Google sign-in was closed or access wasn't approved. Select Connect and finish Google's sign-in steps.");
  }
  if (message.includes("authorization page could not be loaded")) {
    return calendarError("auth", "Chrome couldn't load Google's sign-in page. Check your connection and try again. If Google displays an error, copy its error details.");
  }
  if (message.includes("did not redirect to the right url")) {
    return calendarError("auth", "Google didn't return to WATnow. Check that the Web client's redirect URI matches this extension's ID and ends in /google.");
  }
  if (message.includes("incognito")) return calendarError("auth", "Connect Google Calendar from a regular Chrome window.");
  if (message.includes("not signed in") || message.includes("browser signin") || message.includes("interaction required")) {
    return calendarError("auth", "Chrome needs you to sign in before connecting Google Calendar.");
  }
  if (message.includes("invalid oauth2 client id")) return calendarError("configuration", "Google rejected this build's OAuth client ID. Check the client configuration.");
  if (message.includes("invalid oauth2 scopes")) return calendarError("configuration", "Google rejected the requested permissions. Check the OAuth scope configuration.");
  return calendarError("auth", `Google sign-in couldn't start or finish. Chrome reported: ${browserErrorDetail(error)}`);
}

function consentError(code, interactive) {
  if (!interactive) return calendarError("auth", "Reconnect Google Calendar to continue syncing.");
  const messages = {
    access_denied: "Google denied access. Approve the requested permissions and check that this account is an OAuth test user.",
    admin_policy_enforced: "Your Google account administrator blocked access to WATnow.",
    org_internal: "This Google app only allows accounts in its organization. Check the OAuth audience setting.",
    redirect_uri_mismatch: "Google rejected the redirect address. Register this extension's exact redirect URI on the Web client.",
    invalid_client: "Google rejected the OAuth client. Check this build's Web client ID.",
    invalid_scope: "Google rejected the requested permissions. Check the OAuth scope configuration.",
    temporarily_unavailable: "Google sign-in is temporarily unavailable. Try again shortly.",
    server_error: "Google couldn't finish sign-in. Try again shortly.",
    interaction_required: "Google needs you to sign in and approve access. Select Connect to try again.",
    login_required: "Sign in to Google, then select Connect again.",
    consent_required: "Google needs permission to sync your deadlines. Select Connect and approve access.",
  };
  return calendarError("auth", Object.hasOwn(messages, code) ? messages[code] : "Google returned an authorization error. Check the Google window's error details.");
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
  if (!user.sub || !user.email || !user.email_verified) throw calendarError("auth", "Google didn't confirm an email address. Reconnect to try again.");
  return { id: user.sub, email: user.email };
}

async function authorize({ interactive, account }) {
  if (!googleConfigured()) throw calendarError("configuration", "Google Calendar isn't configured in this build yet. See the local setup instructions.");
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
 * Silent renewal is pinned to the verified Google subject, never the default
 * browser account. If Google needs interaction, sync waits for Reconnect. */
async function authorizeWeb({ interactive, account }) {
  if (!GOOGLE_WEB_CLIENT_ID) throw calendarError("configuration", "Account switching needs a Web OAuth client configured for this build.");
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
  try { returned = new URL(response); } catch {
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
  // Google can return the equivalent OpenID email scope for userinfo.email.
  if (scopes.has("email")) scopes.add("https://www.googleapis.com/auth/userinfo.email");
  const seconds = Number(params.get("expires_in"));
  if (!token || params.get("token_type")?.toLowerCase() !== "bearer" || !Number.isFinite(seconds) || seconds <= 0) {
    throw calendarError("auth", "Google didn't return a valid authorization. Reconnect to try again.");
  }
  if (!GOOGLE_SCOPES.every((s) => scopes.has(s))) throw calendarError("auth", "Allow the requested Google Calendar permissions to sync deadlines.");
  const selected = await identify(token);
  if (epoch !== authEpoch) throw calendarError("cancelled", "Connection cancelled.");
  if (account && selected.id !== account.id) throw calendarError("auth", "Google returned a different account. Reconnect to choose where your deadlines go.");
  webToken = { token, accountId: selected.id, expiresAt: Date.now() + seconds * 1000 - 60000 };
  return { token, account: { ...selected, auth: "web" } };
}

/** Called only after a Connect / Change account click. */
export async function connectGoogle() {
  if (!googleConfigured()) throw calendarError("configuration", "Google Calendar isn't configured in this build yet. See the local setup instructions.");
  if (interactiveAuth) throw calendarError("auth", "A Google sign-in window is still open. Finish or close it before trying again.");
  interactiveAuth = true;
  authEpoch++;
  webToken = null;
  try {
    if (GOOGLE_WEB_CLIENT_ID) return await authorizeWeb({ interactive: true });
    // Legacy Chrome clients use the profile's account; clearing the cache does
    // not force an account picker. Change account is gated before reaching here.
    await chrome.identity.clearAllCachedAuthTokens();
    return await authorize({ interactive: true });
  } finally {
    interactiveAuth = false;
  }
}

export async function getGoogleToken(account) {
  if (account.auth === "web") {
    if (webToken?.accountId === account.id && webToken.expiresAt > Date.now()) return webToken.token;
    return (await authorizeWeb({ interactive: false, account })).token;
  }
  return (await authorize({ interactive: false, account })).token;
}

export async function invalidateGoogleToken(token) {
  if (webToken?.token === token) webToken = null;
  await chrome.identity.removeCachedAuthToken({ token });
}

export async function disconnectGoogle() {
  authEpoch++;
  webToken = null;
  await chrome.identity.clearAllCachedAuthTokens();
}
