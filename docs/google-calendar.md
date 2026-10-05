# Connecting WATnow to Google Calendar

The calendar file export in Settings works with no setup at all. This page is
only for the other half: WATnow keeping a calendar in Google that updates
itself whenever a deadline changes.

It is switched off until `extension/src/calendar/google-config.js` has a client
in it. With that file empty, nothing about Google is shown in Settings and no
request is ever made.

## 1. Make the OAuth client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project (or pick one you already have).
2. Enable the **Google Calendar API** for it.
3. Fill in the **OAuth consent screen**: External, the app name students will
   see, your support email, and the link to the privacy policy at
   `watnow.ugmi.ca/privacy`.
4. Add the one scope WATnow asks for:
   `https://www.googleapis.com/auth/calendar.app.created`.
   Do **not** add `calendar` or `calendar.events`. Those reach every calendar
   the student has; `calendar.app.created` reaches only the calendar WATnow
   makes itself, which is the whole point.
5. Create credentials: **OAuth client ID**, type **Web application**.
6. Under **Authorised redirect URIs**, add Chrome's address for the extension:

   ```
   https://<extension-id>.chromiumapp.org/
   ```

   The published extension's id is `iikileknbmejmkaonlhkjkpbfnkidibh`, so for
   the Web Store build that is
   `https://iikileknbmejmkaonlhkjkpbfnkidibh.chromiumapp.org/`. An unpacked
   build has a different id; `chrome.identity.getRedirectURL()` in its service
   worker console prints the one to use.

7. Copy the client id and client secret into `google-config.js`.

The secret is not a secret. Google issues one for installed apps and says so
itself: anything shipped in a browser extension can be read out of it. PKCE is
what actually protects the exchange, and the scope above is all the client can
ever be used for.

## 2. Verification, and the 100 user cap

`calendar.app.created` is a sensitive scope, so until Google verifies the
consent screen:

- at most **100 users** can connect, and
- each of them sees Google's **"Google hasn't verified this app"** warning.

That is fine for testing and for a small group. Going past it means submitting
the consent screen for verification, which wants the privacy policy, a demo
video of the connect flow, and proof you own the domain on the consent screen.
Budget weeks, not days.

Until then, the calendar file export is the one to point students at: it has no
cap, no warning and no sign-in.

## 3. Firefox

Firefox has no fixed redirect address. `identity.getRedirectURL()` there returns

```
https://<uuid>.extensions.allizom.org/
```

where the uuid is generated **per install**, not per extension, so every
student's Firefox has a different one and none of them can be registered with
Google in advance.

The way round it is a page of your own that Google *will* redirect to, which
then forwards the browser to whatever address the extension asked for. WATnow
passes its own redirect address in `state`, so the page needs only:

```html
<!-- https://watnow.ugmi.ca/oauth -->
<script>
  const q = new URLSearchParams(location.search);
  const back = q.get("state");
  if (back && back.startsWith("https://") && back.endsWith(".extensions.allizom.org/")) {
    q.delete("state");
    location.replace(back + "?" + q.toString());
  }
</script>
```

Register that page's address as a redirect URI in the Cloud console, put it in
`GOOGLE_BOUNCE_URL` in `google-config.js`, and Firefox connects the same way
Chrome does. Check the `startsWith`/`endsWith` test above before shipping it:
without it, the page will forward an authorization code to any address a link
asks it to.

Until `GOOGLE_BOUNCE_URL` is set, Firefox shows no Connect button and Settings
points at the file export instead.

## 4. What it does once connected

- Makes one secondary calendar, **WATnow deadlines**, and works only in it.
- Syncs after every read of Learn and Crowdmark, so a moved due date reaches the
  calendar in the same half hour the panel learns about it.
- Sends nothing when nothing changed.
- A moved date updates the event that is already there; handing work in leaves
  the event with a check mark on the title; a deadline that disappears deletes
  its event.
- Disconnecting deletes the WATnow calendar and revokes the token. Nothing else
  in the Google account is ever touched, because the scope cannot reach it.

## 5. Before shipping it

- `identity` is in `manifest.json` `permissions`, and `googleapis.com` and
  `oauth2.googleapis.com` are in `optional_host_permissions`. If you decide not
  to ship the Google half, take all three out so no one is asked for a
  permission the build never uses.
- The README's "What it does with your data" section says WATnow sends nothing.
  That stops being true for students who connect Google, and the section needs
  a line saying so.
- The Firefox manifest declares `data_collection_permissions: { required:
  ["none"] }`. Sending deadline titles and dates to Google has to be declared on
  addons.mozilla.org instead.
