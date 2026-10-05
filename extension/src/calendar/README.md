# Google Calendar

**Your deadlines in a separate WATNOW calendar, updated when profs move dates.**

Google Calendar stays off until you choose Connect and approve access to a Google account. It uses a Google account available through your Chrome profile; that account can be different from your school login. Builds without an OAuth client ID hide the calendar icon and Settings section entirely.

## What you get

- Upcoming deadlines go into a separate WATNOW calendar in the connected Google account. Each account has its own calendar.
- When WATnow reads a changed deadline, it updates the same event. Sync runs while Chrome is open.
- If an item disappears after a successful read of a course that's still listed, its event is removed. If the item comes back, WATnow creates a new event. Events for courses that leave the course list are kept, including finished work. An event deleted in Google stays deleted.
- Clicking the calendar icon first explains what will be shared and offers Connect Google Calendar or Don't sync. Don't sync hides the icon until you choose Connect from Settings. Opening the explanation doesn't request permissions or start Google sign-in.
- Once connected, the calendar icon opens Google Calendar for that account. Connection controls and reminder settings stay in Settings.
- WATnow's existing Chrome reminders work as before. The events it creates have Google reminders turned off.
- Disconnecting stops updates and leaves existing events in Google Calendar.

## Running it from this repo

Load the repository's `extension/` folder in `chrome://extensions` with Developer mode on. No build step is needed.

Enable the Google Calendar API in a development Google Cloud project. Set the audience to External / Testing, add your Google accounts as test users, and add the two scopes listed in [config.js](config.js) under Data Access: `calendar.app.created` and `userinfo.email`.

Create a **Chrome Extension** OAuth client in that project and register the exact extension ID shown in `chrome://extensions`. A Web application client does not work with `chrome.identity.getAuthToken`. Keep the extension ID stable; for a build matching the published extension, the maintainer can provide its public manifest key. See [Chrome's OAuth setup guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth).

Add this top-level field to your development copy of `extension/manifest.json`, replacing the placeholder with the Chrome Extension client ID:

```json
"oauth2": {
  "client_id": "YOUR_CHROME_EXTENSION_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/calendar.app.created",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
```

The client ID is public. No client secret, backend, API key or Web redirect URI is needed. The checked-in manifest intentionally omits `oauth2`, keeping Calendar hidden until configured. Do not ship the placeholder. Reload the extension after changing the manifest.

Open WATnow's settings, scroll below Reminders, and choose **Connect Google Calendar**, or use the calendar icon and accept its explanation. Chrome handles sign-in and consent. Settings shows the verified connected email. This flow does not promise an arbitrary account picker: to use another account, disconnect Calendar and connect from the appropriate Chrome profile. Reconnect stays pinned to the saved account so changing Chrome's default account cannot silently move your deadlines.

## How the connection works

Every sync asks `chrome.identity.getAuthToken` non-interactively for a token for the saved Google account. Chrome owns caching and expiration handling independently of the extension worker. The extension never persists access tokens or refresh tokens. Only an explicit Connect click can request interactive authorization. See [Chrome's identity API](https://developer.chrome.com/docs/extensions/reference/api/identity#method-getAuthToken).

A rejected token is removed from Chrome's cache. Account verification retries once with a fresh token; Calendar API failures use the existing bounded retry queue. Recognized transient connection failures retry instead of immediately demanding Reconnect. Revoked access, missing consent or an unavailable account can still require user action. Disconnect cancels pending authorization, clears the extension's Chrome token cache, and stops sync.

Connections from the earlier Web flow require one explicit Reconnect to authorize the Chrome client for the same account. Calendar IDs and event records are retained. If the new client cannot access the existing calendar, syncing pauses for investigation rather than silently creating a replacement. Native connections saved by older builds without an `auth` field continue through Chrome normally.

The calendar ID is saved per account and reused on reconnect. WATnow no longer reads the calendar list. After uninstalling or deleting local data, it can't find an old calendar automatically, so a new connection may create another WATNOW calendar. If a creation response is lost, background sync pauses instead of trying to create another calendar. Check Google Calendar before reconnecting; that explicit action permits another creation attempt.

Event records distinguish a source removal from a deletion in Google. Removal intent is saved before the request, so a lost response can be retried safely. Republished items use a new Google event ID because Google can retain the deleted ID as a tombstone. Old records without course/source information are kept until that information can be read again. Older builds stored both kinds of deletion as just `deleted: true`; those ambiguous records remain untouched rather than restoring events the user may have deleted.

## What it does with your data

- Connecting sends course names, deadline titles, dates, completion status and assignment links directly to Google.
- WATnow reads your email to show the connected account. It uses the saved calendar ID to access its own calendar and doesn't read your calendar list or events from your other calendars.
- Account details, calendar IDs and event sync records are saved in your browser's extension storage on your computer. Each Google account has its own records.
- Disconnecting, deleting local data or uninstalling WATnow doesn't delete the calendar or events already saved in Google. You can delete them in Google Calendar.

The hosted privacy policy is at [watnow.ugmi.ca/privacy](https://watnow.ugmi.ca/privacy/).

## Before releasing it

Run the regression suite from the repository root with Node.js 22 or newer:

```sh
node --test --test-isolation=none tests/calendar-regressions.test.mjs
```

The suite covers hide/republish, interrupted deletion, course removal, incomplete reads, legacy records, ownership, duplicate-insert recovery, opt-out persistence and Settings compatibility. Authentication tests exercise fresh worker instances, token renewal, rejected-token retries, account matching, partial consent, disconnect races and migration from Web connections. Chrome and Google are mocked: passing tests prove our integration behavior, not real Chrome account or renewal behavior. No live Google account is used by these tests.

Keep `oauth2` absent in release builds until the checks below are complete. Use a development Chrome Extension client for testing, then configure the production client for the published extension ID.

**Live authentication validation is still a release blocker.** In a real Chrome profile:

1. Connect and confirm the email and separate WATNOW calendar are correct.
2. Stop the extension worker, reopen the panel, change an item and confirm its existing event updates.
3. Fully quit Chrome, wait over an hour, reopen it and check off an item. Confirm the event updates without Reconnect. Also test with Gmail tabs closed and with Google website sessions signed out while Chrome profile sign-in remains available.
4. Test a profile with no Google sign-in, multiple Google accounts, and a school account different from the Google account. Confirm consent appears only after Connect and no update goes to a different account.
5. Revoke access and confirm background work pauses for Reconnect without opening a window. Test offline/recovery, partial consent and Disconnect while Connect is pending.
6. Test upgrading an existing WATnow install: no disable-on-update permission prompt, no calendar prompt for users who never opted in, and authenticated Calendar create/update/delete requests work without a Google host permission.

These live checks have not been completed here. If Chrome-managed authentication cannot meet the required account/restart behavior, keep the feature disabled and reassess whether an authorization backend is justified. Google Cloud scope verification and the disclosures below remain separate release requirements.

`identity` is the only new Chrome permission. The Google host permission has been removed: the APIs support bearer-token requests through CORS. Read-only preflight checks passed for userinfo and Calendar create, update and delete endpoints with a Chrome extension origin. Verify authenticated requests in the real unpacked extension as well. See [Google's CORS documentation](https://developers.google.com/identity/oauth2/web/guides/use-token-model#use_rest_and_cors_with_google_apis).

The integration no longer requests `calendar.calendarlist.readonly`. Google's [Calendar scope reference](https://developers.google.com/workspace/calendar/api/auth) and [calendar metadata endpoint](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get) support the narrower `calendar.app.created` access used here. Confirm the remaining scopes' classifications in the project's Data Access page and finish any required verification before release. Dropping calendar-list access alone is not proof that the app is exempt from verification, branding review or Testing audience limits. See [Google's verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

The maintainer must update the hosted privacy policy and Chrome Web Store description before release. Their existing statements about school data staying local, read-only requests, anonymous counts being the only outgoing data, and uninstalling removing everything need an exception for Google Calendar. Explain what is shared, what account information is read, and that Google events remain after disconnecting or uninstalling.

Review the store's data-use categories and explain the added `identity` permission in the publisher dashboard. Those disclosures are managed separately from this repository; editing a README doesn't update them. See [Chrome's privacy fields guide](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).

This public repository is a generated mirror. The maintainer will bring the reviewed changes into the private source repository by hand; merging this branch into the mirror doesn't preserve it across later publishes.
