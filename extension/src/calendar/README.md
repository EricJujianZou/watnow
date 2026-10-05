# Google Calendar Integration

**Your course deadlines in a separate WATNOW calendar, kept up-to-date as dates change.**

Google Calendar integration is optional and stays off until you explicitly choose to connect it. When connected, upcoming deadlines and pushed dates are synced to a dedicated "WATNOW" secondary calendar in your chosen Google account.

## What it does

- Deadlines across all your active courses sync to a separate secondary calendar named **WATNOW**.
- When instructors update or move a due date on Learn/Crowdmark, WATnow automatically updates the calendar event.
- Checked-off and submitted work remain on the calendar with a check mark (`✓`) and their completion time.
- If an instructor temporarily unpublishes/hides an assignment to edit it and republishes it later, WATnow recreates the event.
- At the end of a term or when a course is dropped, past events and finished work remain in Google Calendar and are not wiped.
- Google Calendar reminders are turned off by default on synced events, so you continue to rely on WATnow's customizable reminders without receiving double notifications.
- Disconnecting Google Calendar or deleting local data stops synchronization while preserving the events already created in Google Calendar.

## Permissions & Scopes

To protect student privacy and avoid broad account access:
- **`identity`** is added to extension permissions in `manifest.json`.
- No extra host permissions are requested; Google APIs allow CORS with standard bearer tokens.
- **Non-sensitive OAuth scopes:**
  - `https://www.googleapis.com/auth/calendar.app.created`: Restricts calendar access solely to secondary calendars created by WATnow. WATnow cannot see or touch your primary calendar or personal events.
  - `https://www.googleapis.com/auth/userinfo.email`: Confirms the account email to display in Settings.

## Local Development Setup

To test Google Calendar synchronization locally:

1. In the [Google Cloud Console](https://console.cloud.google.com/):
   - Create a project (or select an existing one) and enable the **Google Calendar API**.
   - Configure the OAuth consent screen (under **Google Auth Platform** or **APIs & Services** → **OAuth consent screen**):
     - Set user type to **External**.
     - Fill in the app name and support email.
     - Go to **Audience** (or the **Test users** section), click **+ Add users**, and enter your Google account email. *(While the app is in Testing mode, Google restricts logins to accounts explicitly listed as test users).*
2. Under **Credentials** (or **Clients**):
   - Create an **OAuth client ID** with application type **Web application**.
   - In Chrome, navigate to `chrome://extensions`, enable **Developer mode**, and click **Load unpacked** on the repository's `extension/` directory.
   - Copy the extension ID (a 32-letter string, e.g. `iikileknbmejmkaonlhkjkpbfnkidibh`).
   - In Google Cloud Console, under **Authorized redirect URIs**, click **+ Add URI** and enter:
     ```
     https://<YOUR_EXTENSION_ID>.chromiumapp.org/google
     ```
3. In `extension/src/calendar/config.js`:
   - Set `GOOGLE_WEB_CLIENT_ID` to your copied Web application Client ID.
   - Reload the extension in `chrome://extensions`.
   *(Keep this local and do not commit your personal Client ID to git).*
4. In WATnow:
   - Click the calendar icon in the top bar or open Settings and choose **Connect Google Calendar**.
   - If prompted with a "Google hasn't verified this app" warning, click **Advanced** → **Go to WATnow (unsafe)** → **Continue** (standard for personal test apps in developer mode).
