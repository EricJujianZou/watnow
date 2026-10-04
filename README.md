<div align="center">

<img src="docs/media/mark.png" width="96" alt="">

# WATnow &nbsp;<a href="https://chromewebstore.google.com/detail/watnow/iikileknbmejmkaonlhkjkpbfnkidibh"><img src="https://img.shields.io/badge/Chrome%20Web%20Store-Add%20to%20Chrome-FFE45C?style=flat-square&labelColor=17181C&logo=googlechrome&logoColor=white" alt="Add to Chrome from the Chrome Web Store"></a>

**All your course deadlines in one side panel, updated when profs move dates, with reminders before things close.**

A Chrome extension for students at Waterloo, Guelph, Laurier, McMaster, Queen's, Western and TMU. It reads your school's Brightspace site, which Waterloo calls Learn.

[Chrome Web Store](https://chromewebstore.google.com/detail/watnow/iikileknbmejmkaonlhkjkpbfnkidibh) &nbsp;·&nbsp; [Website](https://watnow.ugmi.ca) &nbsp;·&nbsp; [Privacy policy](https://watnow.ugmi.ca/privacy/)

![manifest v3](https://img.shields.io/badge/Chrome-Manifest_V3-FFE45C?style=flat-square&labelColor=17181C)
![license](https://img.shields.io/badge/license-MIT-FFE45C?style=flat-square&labelColor=17181C)
![installs](https://img.shields.io/badge/installs-1541-FFE45C?style=flat-square&labelColor=17181C)

</div>

https://github.com/user-attachments/assets/0308c84c-db48-4fef-b2ab-1eab881b1191

---

## What you get

- Every dated thing across your courses sits in one list, sorted into Overdue, Today, This week, Next week and Later. Click an item and it opens on your course site.
- WATnow rereads your course site every 30 minutes while Chrome is open. When a prof pushes a due date, the item shows the new date highlighted with the old one crossed out underneath, so you never have to go back and correct a calendar by hand.
- Assignments, labs, quizzes and discussions each get their own reminder lead time, anywhere from seven days before the due date to the morning it's due. Reminders stop once your course site shows you submitted, or once you tick the item off yourself.
- Waterloo students can connect Crowdmark too, and its assignments show up in the same list under the matching course.
- Connect [Google Calendar](extension/src/calendar/README.md) to keep a separate WATNOW calendar updated with your deadlines.
- The panel still works when your course site is down or your laptop is offline. It keeps showing the list it last read and keeps your reminders, then tries again at the next check.

## What it looks like

<table>
<tr>
<td width="50%"><img src="docs/media/moved-date.png" alt="The side panel with a STAT 230 assignment that moved to today, the new date on a yellow pill and the old date crossed out in red underneath."></td>
<td width="50%"><img src="docs/media/demo-settings.png" alt="The reminder settings, with a slider for assignments, labs and quizzes running from seven days before the due date to the morning of."></td>
</tr>
<tr>
<td>A prof pushed Assignment 1 to today. The new date sits on a yellow pill and the date it used to be is crossed out underneath.</td>
<td>Every kind of deadline gets its own lead time, and you can switch a kind off completely.</td>
</tr>
<tr>
<td><img src="docs/media/demo-list-light.png" alt="The side panel in light mode, listing deadlines under Overdue, Today and This week."></td>
<td><img src="docs/media/demo-list-dark.png" alt="The same list in dark mode."></td>
</tr>
<tr>
<td>The list runs from overdue items down to the weeks ahead, and the card at the top says how much is actually due.</td>
<td>The panel follows your Chrome theme, or you can pin it to light or dark.</td>
</tr>
</table>


## Usage

These numbers come from the anonymous install counts described under "What it does with your data". They were last updated on October 3, 2026.

- 1,541 people have installed WATnow.
- 1,070 of them opened it in the last 7 days.
- 36% opened it again the day after they installed it, and 59% came back on some later day.

The user count on the Chrome Web Store runs a few days behind these numbers.

## Install

Install WATnow from the [Chrome Web Store](https://chromewebstore.google.com/detail/watnow/iikileknbmejmkaonlhkjkpbfnkidibh). Click the WATnow icon in your toolbar and choose your school. Sign in to your course site if you aren't already, and the panel fills itself in.

## What it does with your data

This repo is public so you can read exactly what the extension does with your school account before you install it.

- It reads your course site from inside your browser, using the session you're already signed in with. It never sees your password.
- It only reads your school and Crowdmark data, so it can't change assignments or submissions on either site.
- Chrome asks you before WATnow can read any school other than Waterloo, or Crowdmark.
- Your courses, deadlines and settings are saved in your browser's extension storage on your own computer.
- If you connect Google Calendar, WATnow shares course and deadline details with Google. See [what the connection shares and saves](extension/src/calendar/README.md#what-it-does-with-your-data).
- Separately, it sends an anonymous count: once when you install it, once each time you open the panel, and once a day if you used it that day. Each one carries a random install ID and the version number, nothing from your courses. That code is in [`extension/src/core/usage.js`](extension/src/core/usage.js).

The full policy is at [watnow.ugmi.ca/privacy](https://watnow.ugmi.ca/privacy/).

## Running it from this repo

This section is for developers. Most people should use the Chrome Web Store link above, which also keeps the extension updated.

`extension/` is the same build that goes to the Chrome Web Store: it reads live course sites only, and the demo fixtures used for recording videos are stripped out. Open `chrome://extensions`, turn on Developer mode, and use **Load unpacked** on the `extension/` folder.

For Google Calendar setup, account access and release notes, see the [Google Calendar README](extension/src/calendar/README.md).

---

WATnow is not affiliated with or endorsed by D2L, Crowdmark, or any of the universities above.

Made by Eric Zou. Questions go to [eric@ugmi.ca](mailto:eric@ugmi.ca).
