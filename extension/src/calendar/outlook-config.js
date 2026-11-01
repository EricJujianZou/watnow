// Outlook calendar sync: public configuration. Never put a client secret in the extension.
//
// OUTLOOK_CLIENT_ID is the Application (client) ID of an app registered in the
// Microsoft Entra admin center (Azure portal), with this extension's redirect
// URL from chrome.identity.getRedirectURL("outlook") added as a redirect URI.
// Until one is filled in, the Outlook section stays out of the settings, the
// same way the Google Calendar sync does without its client ID.
export const OUTLOOK_CLIENT_ID = "";

// "common" signs in both personal Microsoft accounts (outlook.com, hotmail.com)
// and work or school accounts (a university's Microsoft 365).
export const OUTLOOK_TENANT = "common";

export const OUTLOOK_SCOPES = ["Calendars.ReadWrite", "User.Read", "offline_access"];

// The calendar WATnow keeps its events in, separate from the student's own.
export const OUTLOOK_CALENDAR_NAME = "WATnow";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export function outlookConfigured() {
  return !!OUTLOOK_CLIENT_ID;
}
