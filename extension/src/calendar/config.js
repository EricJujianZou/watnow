// Public OAuth configuration. Never put a client secret in the extension.
// Register chrome.identity.getRedirectURL("google") on a Web application client
// to enable explicit account selection. Existing Chrome clients still connect.
export const GOOGLE_WEB_CLIENT_ID = "";
export const CALENDAR_NAME = "WATNOW";
export const CALENDAR_MARKER = "WATnow managed deadlines v1";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  // Read calendar names to recover our calendar after a lost create response
  // or a reinstall. This does not grant access to other calendars' events.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function googleConfigured() {
  return !!GOOGLE_WEB_CLIENT_ID || !!chrome.runtime.getManifest().oauth2?.client_id;
}
