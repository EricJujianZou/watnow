/*
  The Google Cloud client WATnow signs in with.

  Empty means Google Calendar is switched off: nothing is shown for it in
  settings and no request is ever made. The calendar file export does not need
  any of this and keeps working either way.

  To fill these in, see docs/google-calendar.md.

  The secret is not a secret. Google issues one for installed apps and says so
  itself: anything shipped to a browser can be read out of it. It is here
  because Google's token endpoint asks for it, and the scope below is the only
  thing it can be used for. PKCE is what actually protects the exchange.
*/

export const GOOGLE_CLIENT_ID = "";
export const GOOGLE_CLIENT_SECRET = "";

/**
 * Only secondary calendars this app made itself.
 *
 * Deliberately not calendar.events, which would reach every calendar the
 * student has. With this one WATnow can make its own calendar and work inside
 * it, and cannot see or touch anything else in their Google account.
 */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_API = "https://www.googleapis.com/calendar/v3";

/**
 * A page of yours that bounces the sign-in back into the extension, for a
 * browser whose redirect address is not fixed. Empty on Chrome, where the
 * address is the extension's own and can be registered with Google. See
 * redirectUri() in google.js.
 */
export const GOOGLE_BOUNCE_URL = "";

export const googleConfigured = () => Boolean(GOOGLE_CLIENT_ID);
