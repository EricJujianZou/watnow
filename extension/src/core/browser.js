// Arc detection helpers. No imports so the content script can inline the page check.

const ARC_VARS = ["--arc-palette-title", "--arc-palette-background"];

function arcVarsPresent(doc) {
  const style = doc.defaultView.getComputedStyle(doc.documentElement);
  return ARC_VARS.every((name) => style.getPropertyValue(name).trim());
}

/** True when Arc has injected its palette CSS variables on a page. */
export function isArcPage(doc) {
  return new Promise((resolve) => {
    if (arcVarsPresent(doc)) {
      resolve(true);
      return;
    }
    let tries = 0;
    const timer = doc.defaultView.setInterval(() => {
      tries += 1;
      if (arcVarsPresent(doc)) {
        doc.defaultView.clearInterval(timer);
        resolve(true);
      } else if (tries >= 12) {
        doc.defaultView.clearInterval(timer);
        resolve(false);
      }
    }, 250);
  });
}
