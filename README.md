# WATnow

WATnow is a Chrome extension for University of Waterloo students. It reads your deadlines from Learn (learn.uwaterloo.ca) and lists them in Chrome's side panel, and it reminds you before they close.

This repo is public so you can read exactly what the extension does with your Learn account before you install it.

## What it does with your data

- It reads Learn from inside your browser, using the session you're already signed in with. It never sees your password.
- It only sends GET requests to `learn.uwaterloo.ca/d2l/api/`, so it can't change anything on Learn.
- Everything it reads is saved in your browser's extension storage on your computer.
- The one thing it sends anywhere is an anonymous count to Umami each time you open the panel, with a random ID and the version number. The code for that is in `extension/src/core/usage.js`.

The full privacy policy is at https://watnow.ugmi.ca/privacy/

## Installing

If you're in the beta, follow the steps at https://watnow.ugmi.ca/beta/ and download the `watnow-<version>.zip` file from the latest release. The Source code downloads GitHub adds to each release are the demo build used for recording videos, not the build to install.

## Building

`python3 scripts/package-extension.py` writes the tester build to `dist/`. The `extension/` folder itself loads as the demo build, with made-up courses and keyboard shortcuts for recording.

WATnow is not affiliated with or endorsed by D2L or the University of Waterloo.

Made by Eric Zou. Questions go to eric@ugmi.ca.
