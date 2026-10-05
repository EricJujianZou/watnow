// Chrome owns token caching and renewal, independently of worker lifetime.
// Never save tokens or authorization URLs in local storage or debug reports.
import { GOOGLE_SCOPES, googleConfigured } from "./config.js";

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

/** Details are for developers; students get a short, actionable message. */
export function configurationError(detail) {
  console.warn("Google Calendar configuration:", browserErrorDetail(detail));
  return calendarError("configuration", "Google Calendar couldn't connect. Try again later.");
}

export function calendarMessage(error) {
  if (["configuration", "auth", "network", "token", "api", "ownership", "setup", "calendar-missing", "cancelled"].includes(error?.code)) return error.message;
  console.warn("Google Calendar:", browserErrorDetail(error));
  return "Google Calendar couldn't connect. Try again later.";
}

/** Translate known errors; keep a sanitized Chrome reason for unknown ones. */
function authorizationError(error, interactive) {
  const message = String(typeof error === "string" ? error : error?.message || "").toLowerCase();
  if (message.includes("invalid oauth2 client id")) return configurationError("Invalid OAuth client ID");
  if (message.includes("invalid oauth2 scopes")) return configurationError("Invalid OAuth scopes");
  if (/network|connection failed|service unavailable|temporarily unavailable|service error/.test(message)) {
    return calendarError("network", "Couldn't reach Google. We'll try again.", true);
  }
  if (!interactive) return calendarError("auth", "Reconnect Google Calendar to continue syncing.");
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
    return calendarError("auth", "Chrome couldn't load Google's sign-in page. Check your connection and try again.");
  }
  if (message.includes("did not redirect to the right url")) {
    return configurationError("Google did not return to the registered redirect URI");
  }
  if (message.includes("incognito")) return calendarError("auth", "Connect Google Calendar from a regular Chrome window.");
  if (message.includes("not signed in") || message.includes("browser signin") || message.includes("interaction required")) {
    return calendarError("auth", "Chrome needs you to sign in before connecting Google Calendar.");
  }
  console.warn("Google Calendar sign-in:", browserErrorDetail(error));
  return calendarError("auth", "Google Calendar couldn't connect. Try again later.");
}

async function identify(token) {
  let res;
  try {
    res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
      mode: "cors",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw calendarError("network", "Couldn't reach Google. We'll try again.", true);
  }
  if (res.status === 401) {
    await invalidateGoogleToken(token);
    throw calendarError("token", "Google authorization expired. Retrying shortly.", true);
  }
  if (!res.ok) throw calendarError("network", "Google couldn't confirm the account. Try again.", true);
  const user = await res.json();
  if (!user.sub || !user.email || !user.email_verified) throw calendarError("auth", "Google didn't confirm an email address. Reconnect to try again.");
  return { id: user.sub, email: user.email };
}

async function authorize({ interactive, account }) {
  if (!googleConfigured()) throw configurationError("Missing Chrome Extension OAuth client ID");
  const epoch = authEpoch;
  const checkCurrent = async (token) => {
    if (epoch === authEpoch) return;
    if (token) await invalidateGoogleToken(token).catch(() => {});
    throw calendarError("cancelled", "Connection cancelled.");
  };
  // A rejected cached token gets one fresh attempt. Repeating consent windows
  // is never part of a retry, even when the first request was interactive.
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await chrome.identity.getAuthToken({
        interactive: interactive && attempt === 0,
        enableGranularPermissions: true,
        scopes: GOOGLE_SCOPES,
        ...(account ? { account: { id: account.id } } : {}),
      });
    } catch (e) {
      await checkCurrent();
      throw authorizationError(e, interactive && attempt === 0);
    }
    await checkCurrent(result?.token);
    const granted = new Set(result?.grantedScopes || []);
    if (granted.has("email")) granted.add("https://www.googleapis.com/auth/userinfo.email");
    if (!result?.token || !GOOGLE_SCOPES.every((s) => granted.has(s))) {
      if (result?.token) await invalidateGoogleToken(result.token);
      throw calendarError("auth", "Allow the requested Google Calendar permissions to sync deadlines.");
    }
    let selected;
    try {
      selected = await identify(result.token);
    } catch (e) {
      await checkCurrent(result.token);
      if (e.code === "token" && attempt === 0) continue;
      throw e;
    }
    await checkCurrent(result.token);
    if (account && selected.id !== account.id) {
      await invalidateGoogleToken(result.token);
      throw calendarError("auth", "The connected Google account isn't available in Chrome. Sign into that account in Chrome and reconnect, or disconnect Calendar first to use another account.");
    }
    return { token: result.token, account: { ...selected, auth: "chrome" } };
  }
}

/** Only an explicit Connect click may ask Chrome to show sign-in or consent.
 * Reconnect stays pinned to the saved account. Disconnect first to use Chrome's
 * current default account. Clearing all tokens is reserved for Disconnect. */
export async function connectGoogle(account = null) {
  if (!googleConfigured()) throw configurationError("Missing Chrome Extension OAuth client ID");
  if (interactiveAuth) throw calendarError("auth", "A Google sign-in window is still open. Finish or close it before trying again.");
  interactiveAuth = true;
  authEpoch++;
  try {
    return await authorize({ interactive: true, account });
  } finally {
    interactiveAuth = false;
  }
}

export async function getGoogleToken(account) {
  if (!account?.id) throw calendarError("auth", "Reconnect Google Calendar to continue syncing.");
  // Web grants do not migrate implicitly to a different OAuth client. Keep
  // calendar IDs and event records, but require one explicit native reconnect.
  if (account.auth === "web") {
    throw calendarError("auth", "Reconnect Google Calendar once to use Chrome's connection.");
  }
  return (await authorize({ interactive: false, account })).token;
}

export async function invalidateGoogleToken(token) {
  await chrome.identity.removeCachedAuthToken({ token });
}

export async function disconnectGoogle() {
  authEpoch++;
  await chrome.identity.clearAllCachedAuthTokens();
}
