# Google Calendar

**Your deadlines in a separate WATNOW calendar, updated when profs move dates.**

Google Calendar stays off until you connect it in WATnow's settings and approve access to a Google account. You can choose a different account from the one you use for school.

## What you get

- Upcoming deadlines go into a separate WATNOW calendar in the account you choose. Each account has its own calendar.
- When WATnow reads a changed deadline, it updates the same event. Sync runs while Chrome is open.
- Once connected, the calendar icon opens Google Calendar for that account. Connection controls and reminder settings stay in Settings.
- WATnow's existing Chrome reminders work as before. The events it creates have Google reminders turned off.
- Disconnecting stops updates and leaves existing events in Google Calendar.

## Running it from this repo

Load the repository's `extension/` folder in `chrome://extensions` with Developer mode on. No build step is needed.

Enable the Google Calendar API in a development Google Cloud project. Set the audience to External / Testing, add your Google accounts as test users, and add the three scopes listed in [config.js](config.js) under Data Access.

Create a **Web application** OAuth client. Set its authorized redirect URI to `https://YOUR_EXTENSION_ID.chromiumapp.org/google`, using the unpacked extension's ID from `chrome://extensions`. Keep that ID stable: if it changes, the redirect registered with Google must change too.

Set `GOOGLE_WEB_CLIENT_ID` in [config.js](config.js) to your public client ID, then reload the extension. The client ID identifies the app; it isn't a secret. No client secret is used or bundled.

Open WATnow's settings and choose **Connect Google Calendar**. Both Connect and Change account request Google's account picker. See [Google's account-selection parameter](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow#creatingclient) and [Chrome's redirect API](https://developer.chrome.com/docs/extensions/reference/api/identity#method-getRedirectURL).

## How the connection works

Web sign-in tokens stay in the extension's background worker memory. After a token expires or the worker restarts, WATnow tries to renew access silently for the selected account and checks that Google returned the same account. If Google needs sign-in or consent, syncing pauses and Settings shows Reconnect. Background syncing never opens a sign-in window. Testing-mode authorizations expire after seven days.

Older builds with a Chrome Extension OAuth client in the manifest can still connect through Chrome's profile account. That API can't force an account picker, so Change account explains that a Web client is needed. Existing native connections keep working until the user reconnects through the Web flow.

## What it does with your data

- Connecting sends course names, deadline titles, dates, completion status and assignment links directly to Google.
- WATnow reads your email to show the connected account and your calendar list to find its calendar. It doesn't read events from your other calendars.
- Account details, calendar IDs and event sync records are saved in your browser's extension storage on your computer. Each Google account has its own records.
- Disconnecting, deleting local data or uninstalling WATnow doesn't delete the calendar or events already saved in Google. You can delete them in Google Calendar.

The hosted privacy policy is at [watnow.ugmi.ca/privacy](https://watnow.ugmi.ca/privacy/).

## Before releasing it

Use the production client ID in [config.js](config.js) and register a redirect that matches the published extension's ID.

The Web sign-in flow currently requests an access token directly, with no refresh token. This is called the implicit flow. Google discourages it for modern browser apps and recommends authorization code flow with PKCE. The maintainer should review the production authentication design before release. Google's documented Web code model uses a backend; a client secret must never be put in the extension. See [Google's guidance](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow) and [code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model).

Update the hosted privacy policy and Chrome Web Store description to cover this optional connection. Their existing statements about school data staying local, read-only requests, anonymous counts being the only outgoing data, and uninstalling removing everything need an exception for Google Calendar. Explain what is shared, what account information is read, and that Google events remain after disconnecting or uninstalling.

Review the store's data-use categories and explain the added `identity` and Google API permissions in the publisher dashboard. Those disclosures are managed separately from this repository; editing a README doesn't update them. See [Chrome's privacy fields guide](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).
