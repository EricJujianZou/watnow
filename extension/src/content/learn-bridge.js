/*
  Content script on Learn pages.

  Mock Learn (localhost:8080/d2l/*): the mock pages and the extension talk only
  through DOM events on document.
    page -> extension  "learn-mock:ready"   the page wants course data
    extension -> page  "learn-mock:data"    detail is a JSON string of the fake Learn catalog
    page -> extension  "learn-mock:submit"  detail is JSON { ou, itemId, kind } after Submit on a dropbox or quiz

  LIVE mode, on any matching page:
    background -> here  { type: "live:fetch", path }  runs a GET on this page's
      own origin, which carries the Learn session cookie, and returns
      { status, loginRedirect, type, json }, plus the start of the body when
      the request failed. Only /d2l/api/ paths are allowed.
    here -> background  { type: "live:learn-page", login }  sent once per page
      load while in LIVE mode, so a panel stuck on "Sign in to Learn first"
      can try again after the student signs in.
  See src/data/live-source.js.
*/
(() => {
  const isMock = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "live:fetch") return false;
    const path = String(msg.path || "");
    if (!path.startsWith("/d2l/api/") || path.includes("..")) {
      sendResponse({ status: 0, error: "path not allowed" });
      return false;
    }
    (async () => {
      try {
        const res = await fetch(location.origin + path, { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
        const type = res.headers.get("content-type") || "";
        const out = { status: res.status, redirected: res.redirected, loginRedirect: /\/d2l\/login/i.test(res.url || ""), type };
        if (res.ok && type.includes("json")) {
          try {
            out.json = await res.json();
          } catch (e) {
            out.parseError = String(e);
          }
        } else if (!res.ok && !out.loginRedirect) {
          // The start of an error body, so the debug report can say why Learn refused.
          try {
            out.body = (await res.text()).slice(0, 2000);
          } catch {
            /* no body */
          }
        }
        sendResponse(out);
      } catch (e) {
        sendResponse({ status: 0, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  });

  chrome.storage.local
    .get("settings")
    .then(({ settings }) => {
      if (!settings || settings.mode !== "live") return;
      chrome.runtime.sendMessage({ type: "live:learn-page", login: /^\/d2l\/login/i.test(location.pathname) }).catch(() => {});
    })
    .catch(() => {});

  if (!isMock) return;

  async function sendData() {
    let catalog;
    try {
      ({ catalog } = await chrome.storage.local.get("catalog"));
    } catch {
      return;
    }
    if (!catalog) return;
    const payload = {
      student: catalog.student,
      term: catalog.term,
      courses: catalog.courses,
      items: catalog.items,
      builtAt: catalog.builtAt,
    };
    document.dispatchEvent(new CustomEvent("learn-mock:data", { detail: JSON.stringify(payload) }));
  }

  document.addEventListener("learn-mock:ready", sendData);

  document.addEventListener("learn-mock:submit", (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    chrome.runtime.sendMessage({ type: "learn:submitted", orgUnitId: d.ou, itemId: d.itemId, kind: d.kind });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.catalog) sendData();
  });

  sendData();
})();
