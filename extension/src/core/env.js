// Which browser WATnow is running in, worked out at runtime so the same
// unpacked folder loads in Chrome and in Firefox-based browsers.
//
// Chrome has chrome.sidePanel and no sidebarAction; Gecko (Firefox, Nightly,
// Zen, LibreWolf) has sidebarAction and no sidePanel. Extension pages and the
// background both get these, so anything that differs between the two asks
// here instead of sniffing the user agent.
//
// Never name the browser in copy the student reads: on Zen or LibreWolf
// "Firefox" is wrong. Say "your browser".

const url = (() => {
  try {
    return chrome.runtime.getURL("/");
  } catch {
    return "";
  }
})();

export const IS_GECKO = url.startsWith("moz-extension://");
export const HAS_SIDE_PANEL = typeof chrome !== "undefined" && !!chrome.sidePanel;
export const HAS_SIDEBAR = typeof chrome !== "undefined" && !!chrome.sidebarAction;
