// One icon family: 20px grid, 1.75 stroke, round caps and joins, drawn for WATnow.

const P = {
  dropbox: '<path d="M3.5 11h3.6l1.1 2h3.6l1.1-2h3.6"/><path d="M3.5 11v3.5A2 2 0 0 0 5.5 16.5h9a2 2 0 0 0 2-2V11l-2.1-5.3a1.8 1.8 0 0 0-1.7-1.2H7.3a1.8 1.8 0 0 0-1.7 1.2z"/>',
  flask: '<path d="M8 3.5h4"/><path d="M8.8 3.5v4.3l-4.1 7a1.2 1.2 0 0 0 1 1.7h8.6a1.2 1.2 0 0 0 1-1.7l-4.1-7V3.5"/><path d="M6.4 12.5h7.2"/>',
  quiz: '<rect x="3.5" y="3.5" width="13" height="13" rx="2"/><path d="M6.6 8.1l1.2 1.2 2.2-2.3"/><path d="M11.8 8.2h1.9"/><path d="M6.6 12.9h1.9"/><path d="M11.8 12.9h1.9"/>',
  discussion: '<path d="M3.5 5.3a1.8 1.8 0 0 1 1.8-1.8h6.4a1.8 1.8 0 0 1 1.8 1.8v3.9a1.8 1.8 0 0 1-1.8 1.8H7.6L4.9 13.2V11a1.8 1.8 0 0 1-1.4-1.8z"/><path d="M15.8 8.3a1.7 1.7 0 0 1 .7 1.4v3.6a1.7 1.7 0 0 1-1.2 1.6v2l-2.5-2h-3a1.7 1.7 0 0 1-1.4-.8"/>',
  doc: '<path d="M5.5 3.5h5.8l3.2 3.2v8a1.8 1.8 0 0 1-1.8 1.8H5.5a1.8 1.8 0 0 1-1.8-1.8V5.3a1.8 1.8 0 0 1 1.8-1.8z"/><path d="M11 3.7V7h3.3"/><path d="M6.8 10.5h5.4"/><path d="M6.8 13.3h3.6"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M15.9 12a1.3 1.3 0 0 0 .26 1.44l.05.05a1.6 1.6 0 1 1-2.26 2.26l-.05-.05a1.3 1.3 0 0 0-1.44-.26 1.3 1.3 0 0 0-.79 1.19v.14a1.6 1.6 0 0 1-3.2 0v-.07a1.3 1.3 0 0 0-.85-1.19 1.3 1.3 0 0 0-1.44.26l-.05.05a1.6 1.6 0 1 1-2.26-2.26l.05-.05a1.3 1.3 0 0 0 .26-1.44 1.3 1.3 0 0 0-1.19-.79h-.14a1.6 1.6 0 0 1 0-3.2h.07a1.3 1.3 0 0 0 1.19-.85 1.3 1.3 0 0 0-.26-1.44l-.05-.05a1.6 1.6 0 1 1 2.26-2.26l.05.05a1.3 1.3 0 0 0 1.44.26h.06a1.3 1.3 0 0 0 .79-1.19v-.14a1.6 1.6 0 0 1 3.2 0v.07a1.3 1.3 0 0 0 .79 1.19 1.3 1.3 0 0 0 1.44-.26l.05-.05a1.6 1.6 0 1 1 2.26 2.26l-.05.05a1.3 1.3 0 0 0-.26 1.44v.06a1.3 1.3 0 0 0 1.19.79h.14a1.6 1.6 0 0 1 0 3.2h-.07a1.3 1.3 0 0 0-1.19.79z"/>',
  zzz: '<path d="M3 10.5h4.4L3 15.4h4.4"/><path d="M9.4 7.1h3.4l-3.4 3.8h3.4"/><path d="M14.4 4.5h2.6l-2.6 2.9h2.6"/>',
  check: '<path d="M5 10.4l3.2 3.1L15 6.6"/>',
  alert: '<circle cx="10" cy="10" r="6.75"/><path d="M10 6.6v4.1"/><path d="M10 13.4v.05"/>',
  clock: '<circle cx="10" cy="10" r="6.75"/><path d="M10 6.4V10l2.4 1.6"/>',
  refresh: '<path d="M15.6 8.4A5.9 5.9 0 0 0 4.9 6.6"/><path d="M4.4 11.6a5.9 5.9 0 0 0 10.7 1.8"/><path d="M15.8 4.2v4.3h-4.3"/><path d="M4.2 15.8v-4.3h4.3"/>',
  sliders: '<path d="M3.5 6.5h7"/><path d="M15 6.5h1.5"/><circle cx="12.8" cy="6.5" r="2"/><path d="M3.5 13.5h1.7"/><path d="M9.5 13.5h7"/><circle cx="7.3" cy="13.5" r="2"/>',
  back: '<path d="M12 4.5 6.5 10l5.5 5.5"/>',
  chev: '<path d="M7.5 5l5 5-5 5"/>',
  arrow: '<path d="M4 10h11"/><path d="M11 6l4 4-4 4"/>',
  lock: '<rect x="4.5" y="8.5" width="11" height="8" rx="1.8"/><path d="M7 8.5V6.8a3 3 0 0 1 6 0v1.7"/>',
  checklist: '<path d="M3.8 6l1.3 1.3L7.6 4.8"/><path d="M3.8 12.4l1.3 1.3 2.5-2.5"/><path d="M10.2 6h6"/><path d="M10.2 12.5h6"/>',
  bell: '<path d="M5.8 8.3a4.2 4.2 0 0 1 8.4 0c0 4.3 1.8 5.8 1.8 5.8H4s1.8-1.5 1.8-5.8z"/><path d="M8.4 16.6a1.8 1.8 0 0 0 3.2 0"/>',
  moon: '<path d="M15.9 12.3A6.5 6.5 0 0 1 7.7 4.1a6.5 6.5 0 1 0 8.2 8.2z"/>',
  info: '<circle cx="10" cy="10" r="6.75"/><path d="M10 9.2v4"/><path d="M10 6.6v.05"/>',
  play: '<path d="M6.5 4.8v10.4l8.3-5.2z"/>',
  keyboard: '<rect x="2.8" y="5.5" width="14.4" height="9" rx="1.8"/><path d="M6 8.5h.05M9 8.5h.05M12 8.5h.05M15 8.5h.05"/><path d="M6.5 11.5h7"/>',
  external: '<path d="M11 3.5h5.5V9"/><path d="M16.5 3.5 9.5 10.5"/><path d="M14.5 12v2.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.3a1.8 1.8 0 0 1 1.8-1.8H8"/>',
};

export const CATEGORY_ICON = {
  assignment: "dropbox",
  lab: "flask",
  quiz: "quiz",
  discussion: "discussion",
  content: "doc",
};

export function icon(name, size = 20, cls = "") {
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ""}</svg>`;
}

/** The app logo for the panel header and the settings page. */
export function brandMark(size = 22) {
  const src = typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getURL("icons/mark.png") : "../icons/mark.png";
  return `<img class="brand-mark" src="${src}" width="${size}" height="${size}" alt="" aria-hidden="true">`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
