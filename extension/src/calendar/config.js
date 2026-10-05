// Public OAuth configuration. Never put a client secret in the extension.
// Configure a Chrome Extension OAuth client in manifest.json's oauth2 field.
// Leaving oauth2 absent keeps Calendar hidden in unconfigured builds.
export const CALENDAR_NAME = "WATNOW";
export const CALENDAR_MARKER = "WATnow managed deadlines v1";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function googleConfigured() {
  return !!chrome.runtime.getManifest().oauth2?.client_id?.trim();
}
