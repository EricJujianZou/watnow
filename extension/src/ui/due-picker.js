/*
  The due date and time picker in the add/edit deadline form.

  Built here rather than using the browser's date and time inputs, whose popups
  can't be styled and look nothing like the rest of the panel. It sits inside
  the form (no popover to clip at the side panel's edge):

    a summary line      "Tue, Oct 27 · 11:59 pm"
    quick picks         Today, Tomorrow, Friday, In a week
    a month             prev/next month, Sunday first like Learn, today ringed,
                        the chosen day filled
    times               the usual deadline times, plus a time field for any other

  Keyboard: the month is a grid. Arrow keys move a day or a week, Home and End
  go to the week's ends, Page Up and Page Down change month, Enter or Space
  picks. Only the chosen (or focused) day is in the tab order.
*/

import { esc, icon } from "./icons.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMES = [
  [9, 0],
  [12, 0],
  [17, 0],
  [23, 59],
];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const pad2 = (n) => String(n).padStart(2, "0");

export function fmtTime(h, m) {
  const suffix = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${pad2(m)} ${suffix}`;
}

/** The quick picks for a given today: Today, Tomorrow, the next Friday (or Friday a week on), and a week from today. */
export function quickPicks(today) {
  const t = startOfDay(today);
  const toFriday = (5 - t.getDay() + 7) % 7 || 7;
  return [
    ["Today", t],
    ["Tomorrow", addDays(t, 1)],
    [toFriday === 7 ? "Next Friday" : "Friday", addDays(t, toFriday)],
    ["In a week", addDays(t, 7)],
  ];
}

/** The 6 x 7 days shown for a month, Sunday first, including the days before and after it. */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/**
 * Puts a picker in `root` and returns { value } (a Date, read when the form is
 * saved). `initial` is the due date being edited, or null for a new one, which
 * starts at today, 11:59 pm.
 */
export function createDuePicker(root, initial = null, { now = () => new Date() } = {}) {
  const today = startOfDay(now());
  let day = initial ? startOfDay(initial) : today;
  let hour = initial ? initial.getHours() : 23;
  let minute = initial ? initial.getMinutes() : 59;
  // The month on screen, which arrows can move away from the chosen day.
  let view = new Date(day.getFullYear(), day.getMonth(), 1);
  let focusDay = day;
  // The month folds away until it's wanted, so the form stays short.
  let monthOpen = false;
  let otherTime = !TIMES.some(([h, m]) => h === hour && m === minute);

  function summary() {
    return `${DAYS[day.getDay()]}, ${MONTHS[day.getMonth()].slice(0, 3)} ${day.getDate()} · ${fmtTime(hour, minute)}`;
  }

  function render({ keepFocus = false } = {}) {
    const days = monthGrid(view.getFullYear(), view.getMonth());
    const weeks = [];
    for (let w = 0; w < 6; w++) weeks.push(days.slice(w * 7, w * 7 + 7));
    const picks = quickPicks(today)
      .map(([label, d]) => `<button type="button" class="dp-chip" data-dp-pick="${d.getTime()}" aria-pressed="${sameDay(d, day)}">${label}</button>`)
      .join("");
    const times = TIMES.map(([h, m]) => `<button type="button" class="dp-chip" data-dp-time="${h}:${m}" aria-pressed="${h === hour && m === minute}">${fmtTime(h, m)}</button>`).join("");
    const custom = otherTime || !TIMES.some(([h, m]) => h === hour && m === minute);
    root.innerHTML = `
      <div class="dp">
        <button type="button" class="dp-summary" data-dp-toggle aria-expanded="${monthOpen}" aria-controls="dp-month">${icon("calendar", 18)}<span aria-live="polite">${esc(summary())}</span><span class="dp-caret" aria-hidden="true">${icon("chev", 16)}</span></button>
        <div class="dp-chips" role="group" aria-label="Quick dates">${picks}</div>
        <div class="dp-month" id="dp-month" ${monthOpen ? "" : "hidden"}>
          <div class="dp-head">
            <button type="button" class="dp-nav" data-dp-nav="-1" aria-label="Previous month">${icon("back", 18)}</button>
            <span class="dp-title" id="dp-title">${MONTHS[view.getMonth()]} ${view.getFullYear()}</span>
            <button type="button" class="dp-nav dp-next" data-dp-nav="1" aria-label="Next month">${icon("back", 18)}</button>
          </div>
          <table class="dp-grid" role="grid" aria-labelledby="dp-title">
            <thead><tr>${DAYS.map((d, i) => `<th scope="col" abbr="${DAYS_LONG[i]}">${d.charAt(0)}</th>`).join("")}</tr></thead>
            <tbody>${weeks
              .map(
                (w) =>
                  `<tr>${w
                    .map((d) => {
                      const out = d.getMonth() !== view.getMonth();
                      const cls = ["dp-day", out ? "is-out" : "", sameDay(d, today) ? "is-today" : "", d < today ? "is-past" : ""].filter(Boolean).join(" ");
                      const label = `${DAYS_LONG[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${sameDay(d, today) ? ", today" : ""}`;
                      return `<td role="gridcell" aria-selected="${sameDay(d, day)}"><button type="button" class="${cls}" data-dp-day="${d.getTime()}" tabindex="${sameDay(d, focusDay) ? 0 : -1}" aria-label="${esc(label)}">${d.getDate()}</button></td>`;
                    })
                    .join("")}</tr>`
              )
              .join("")}</tbody>
          </table>
        </div>
        <div class="dp-times">
          <span class="dp-label" id="dp-time-label">Time</span>
          <div class="dp-chips" role="group" aria-labelledby="dp-time-label">${times}
            ${custom
              ? `<label class="dp-custom is-on"><span class="sr-only">Other time</span><input class="input dp-time-input" type="time" value="${pad2(hour)}:${pad2(minute)}"></label>`
              : '<button type="button" class="dp-chip dp-other" data-dp-other aria-pressed="false">Other time</button>'}
          </div>
        </div>
      </div>`;
    if (keepFocus) root.querySelector(`[data-dp-day="${focusDay.getTime()}"]`)?.focus();
  }

  function pick(d, { focus = false } = {}) {
    day = startOfDay(d);
    focusDay = day;
    view = new Date(day.getFullYear(), day.getMonth(), 1);
    render({ keepFocus: focus });
  }

  function moveFocus(d) {
    focusDay = startOfDay(d);
    if (focusDay.getMonth() !== view.getMonth() || focusDay.getFullYear() !== view.getFullYear()) view = new Date(focusDay.getFullYear(), focusDay.getMonth(), 1);
    render({ keepFocus: true });
  }

  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-dp-pick], [data-dp-day], [data-dp-nav], [data-dp-time], [data-dp-toggle], [data-dp-other]");
    if (!t) return;
    if ("dpToggle" in t.dataset) {
      monthOpen = !monthOpen;
      render();
      root.querySelector(monthOpen ? `[data-dp-day="${focusDay.getTime()}"]` : "[data-dp-toggle]")?.focus();
    } else if ("dpOther" in t.dataset) {
      otherTime = true;
      render();
      root.querySelector(".dp-time-input")?.focus();
    } else if (t.dataset.dpPick) pick(new Date(Number(t.dataset.dpPick)));
    else if (t.dataset.dpDay) pick(new Date(Number(t.dataset.dpDay)), { focus: true });
    else if (t.dataset.dpNav) {
      view = new Date(view.getFullYear(), view.getMonth() + Number(t.dataset.dpNav), 1);
      focusDay = sameDay(new Date(day.getFullYear(), day.getMonth(), 1), view) ? day : view;
      render();
      root.querySelector(`[data-dp-nav="${t.dataset.dpNav}"]`)?.focus();
    } else if (t.dataset.dpTime) {
      [hour, minute] = t.dataset.dpTime.split(":").map(Number);
      otherTime = false;
      render();
      root.querySelector(`[data-dp-time="${t.dataset.dpTime}"]`)?.focus();
    }
  });

  root.addEventListener("keydown", (e) => {
    const t = e.target.closest("[data-dp-day]");
    if (!t) return;
    const d = new Date(Number(t.dataset.dpDay));
    const moves = {
      ArrowLeft: () => addDays(d, -1),
      ArrowRight: () => addDays(d, 1),
      ArrowUp: () => addDays(d, -7),
      ArrowDown: () => addDays(d, 7),
      Home: () => addDays(d, -d.getDay()),
      End: () => addDays(d, 6 - d.getDay()),
      PageUp: () => new Date(d.getFullYear(), d.getMonth() - 1, Math.min(d.getDate(), 28)),
      PageDown: () => new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), 28)),
    };
    if (moves[e.key]) {
      e.preventDefault();
      moveFocus(moves[e.key]());
    }
  });

  // Typing a time fires a change for each part (hour, minutes, am/pm), so this
  // only updates the summary and the chips. Redrawing would replace the field
  // under the student's cursor and lose what they type next.
  root.addEventListener("input", onTimeTyped);
  root.addEventListener("change", onTimeTyped);
  function onTimeTyped(e) {
    if (!e.target.matches(".dp-time-input") || !e.target.value) return;
    [hour, minute] = e.target.value.split(":").map(Number);
    const line = root.querySelector(".dp-summary [aria-live]");
    if (line) line.textContent = summary();
    for (const chip of root.querySelectorAll("[data-dp-time]")) {
      const [h, m] = chip.dataset.dpTime.split(":").map(Number);
      chip.setAttribute("aria-pressed", String(h === hour && m === minute));
    }
  }

  render();
  return {
    get value() {
      return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
    },
  };
}
