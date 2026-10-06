/*
  Stages extension/ into dist/<target>/ with a manifest for that browser only.

  extension/manifest.json carries both browsers' keys so the one folder loads
  unpacked in Chrome and in Firefox. Each browser ignores the other's keys with
  a warning, which is fine while developing but not what we ship, so a packaged
  build gets the keys it actually uses and nothing else.

    node tools/pack.mjs firefox   ->  dist/firefox/   (event page + sidebar_action)
    node tools/pack.mjs chrome    ->  dist/chrome/    (service worker + side_panel)

  Then web-ext build turns the staged folder into a zip. See package.json.
*/

import { cp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "extension");

const TARGETS = {
  // Gecko starts an event page from background.scripts; it has no
  // background.service_worker, no side_panel and no sidePanel permission.
  firefox(m) {
    delete m.background.service_worker;
    delete m.side_panel;
    delete m.minimum_chrome_version;
    m.permissions = m.permissions.filter((p) => p !== "sidePanel");
  },
  // Chrome runs a module service worker, opens its own side panel, and has no
  // sidebar or Gecko settings.
  chrome(m) {
    delete m.background.scripts;
    delete m.sidebar_action;
    delete m.browser_specific_settings;
  },
};

const target = process.argv[2];
if (!TARGETS[target]) {
  console.error(`usage: node tools/pack.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(1);
}

const out = join(ROOT, "dist", target);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(SRC, out, { recursive: true });

const manifest = JSON.parse(await readFile(join(SRC, "manifest.json"), "utf8"));
TARGETS[target](manifest);
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// A packaged build is a store build, the same as the Chrome zip from
// scripts/package-extension.py: real Learn only, no demo, usage counts on.
const build = join(out, "src/core/build.js");
await writeFile(build, (await readFile(build, "utf8")).replace("TESTER_BUILD = false", "TESTER_BUILD = true"));

console.log(`${target}: staged ${manifest.name} ${manifest.version} in dist/${target}`);
