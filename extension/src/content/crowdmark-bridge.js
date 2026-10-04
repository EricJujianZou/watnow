/*
  Content script on Crowdmark pages.

  Crowdmark is an optional permission, so this is not in the manifest. The
  background registers it with chrome.scripting once the student connects
  Crowdmark, and unregisters it when they disconnect. See syncBridge() in
  src/background.js.

    background -> here  { type: "crowdmark:fetch", path }  runs a GET on this
      page's own origin, which carries the Crowdmark session, and returns
      { status, signInRedirect, type, json }. Only /api/v2/student/ paths are
      allowed, and nothing is ever written.
    here -> background  { type: "crowdmark:page" }  sent once per page load,
      so a read that failed from the background can be tried again now that
      there is a tab to run it through.

  Why this exists: the background reads Crowdmark with credentials "include",
  which Chrome answers with the session cookie attached. Gecko does not always,
  so a read that comes back signed out falls back to here, where the request
  leaves from Crowdmark's own origin and the cookie is never in question.
  See src/data/crowdmark-source.js.
*/
(() => {
  // The background both registers this script and injects it into tabs that
  // were already open, so the same page can get it twice. A second copy would
  // answer every read as well, and the first sendResponse wins.
  if (window.__watnowCrowdmarkBridge) return;
  window.__watnowCrowdmarkBridge = true;

  const ALLOWED = "/api/v2/student/";
  const TIMEOUT_MS = 20000;
  const SIGN_IN = /\/(?:sign[-_]?in|login|saml|auth)\b/i;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "crowdmark:fetch") return false;
    const path = String(msg.path || "");
    if (!path.startsWith(ALLOWED) || path.includes("..")) {
      sendResponse({ status: 0, error: "path not allowed" });
      return false;
    }
    (async () => {
      try {
        const res = await fetch(location.origin + path, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/vnd.api+json, application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const type = res.headers.get("content-type") || "";
        const out = {
          status: res.status,
          redirected: res.redirected,
          signInRedirect: res.redirected && SIGN_IN.test(new URL(res.url).pathname),
          type,
        };
        if (res.ok && /json/i.test(type)) {
          try {
            out.json = await res.json();
          } catch (e) {
            out.parseError = String(e);
          }
        }
        sendResponse(out);
      } catch (e) {
        sendResponse({ status: 0, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  });

  // A Crowdmark page finished loading. The background decides whether a read is
  // worth trying; a sign-in page means the student is not through it yet.
  if (!SIGN_IN.test(location.pathname)) {
    chrome.runtime.sendMessage({ type: "crowdmark:page" }).catch(() => {});
  }
})();
