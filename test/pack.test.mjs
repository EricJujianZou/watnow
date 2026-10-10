// Exercise the real packaging CLI in a temporary checkout. Tests never write
// to the developer's extension/ or dist/ folders.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let root;
let sourceManifest;
let sourceBuild;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

before(async () => {
  root = await mkdtemp(join(tmpdir(), "watnow-pack-"));
  await mkdir(join(root, "tools"));
  await cp(join(ROOT, "tools/pack.mjs"), join(root, "tools/pack.mjs"));
  await cp(join(ROOT, "extension"), join(root, "extension"), { recursive: true });

  // Simulate a Chrome update URL and a development build in the input so an
  // Edge upload cannot inherit the wrong store or accidentally enable demos.
  sourceManifest = await json(join(root, "extension/manifest.json"));
  sourceManifest.update_url = "https://clients2.google.com/service/update2/crx";
  await writeFile(join(root, "extension/manifest.json"), JSON.stringify(sourceManifest));
  sourceBuild = "export const TESTER_BUILD = false;\n";
  await writeFile(join(root, "extension/src/core/build.js"), sourceBuild);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

for (const target of ["chrome", "edge", "firefox"]) {
  test(`${target} packages the shared extension with the correct browser manifest`, async () => {
    execFileSync(process.execPath, [join(root, "tools/pack.mjs"), target], { cwd: tmpdir() });
    const out = join(root, "dist", target);
    const manifest = await json(join(out, "manifest.json"));
    assert.equal(manifest.version, sourceManifest.version);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.type, "module");
    assert.deepEqual(manifest.host_permissions, sourceManifest.host_permissions);
    assert.deepEqual(manifest.optional_host_permissions, sourceManifest.optional_host_permissions);
    assert.deepEqual(manifest.content_scripts, sourceManifest.content_scripts);

    if (target === "firefox") {
      assert.deepEqual(manifest.background.scripts, ["src/background.js"]);
      assert.equal(manifest.background.service_worker, undefined);
      assert.equal(manifest.sidebar_action.default_panel, "panel/panel.html");
      assert.ok(manifest.browser_specific_settings.gecko.id);
      assert.equal(manifest.side_panel, undefined);
      assert.equal(manifest.minimum_chrome_version, undefined);
      assert.deepEqual(manifest.permissions, sourceManifest.permissions.filter((p) => p !== "sidePanel"));
    } else {
      assert.equal(manifest.background.service_worker, "src/background.js");
      assert.equal(manifest.side_panel.default_path, "panel/panel.html");
      assert.deepEqual(manifest.permissions, sourceManifest.permissions);
      assert.equal(manifest.minimum_chrome_version, sourceManifest.minimum_chrome_version);
      assert.equal(manifest.background.scripts, undefined);
      assert.equal(manifest.sidebar_action, undefined);
      assert.equal(manifest.browser_specific_settings, undefined);
      assert.equal(manifest.update_url, target === "edge" ? undefined : sourceManifest.update_url);
    }

    for (const file of [
      "src/background.js", "src/core/env.js", "src/calendar/config.js",
      "panel/panel.html", "panel/panel.js", "options/options.html",
      "welcome/welcome.html", "src/content/learn-bridge.js", "src/content/crowdmark-bridge.js",
      "icons/icon-128.png", "_locales/en/messages.json",
    ]) {
      assert.deepEqual(await readFile(join(out, file)), await readFile(join(root, "extension", file)), file);
    }
    assert.equal(await readFile(join(out, "src/core/build.js"), "utf8"), "export const TESTER_BUILD = true;\n");
    assert.deepEqual(await json(join(root, "extension/manifest.json")), sourceManifest);
    assert.equal(await readFile(join(root, "extension/src/core/build.js"), "utf8"), sourceBuild);
  });
}

test("rebuilding Edge replaces stale files without disturbing another browser's build", async () => {
  for (const target of ["chrome", "edge"]) execFileSync(process.execPath, [join(root, "tools/pack.mjs"), target]);
  const edge = join(root, "dist/edge");
  const chromeManifest = await readFile(join(root, "dist/chrome/manifest.json"));
  await writeFile(join(edge, "stale.txt"), "old build");
  execFileSync(process.execPath, [join(root, "tools/pack.mjs"), "edge"]);
  await assert.rejects(readFile(join(edge, "stale.txt")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(root, "dist/chrome/manifest.json")), chromeManifest);
});

test("invalid or missing targets fail before touching the source or staged builds", async () => {
  execFileSync(process.execPath, [join(root, "tools/pack.mjs"), "edge"]);
  const edgeManifest = await readFile(join(root, "dist/edge/manifest.json"));
  for (const args of [[], ["safari"], ["constructor"], ["__proto__"], ["../extension"]]) {
    const result = spawnSync(process.execPath, [join(root, "tools/pack.mjs"), ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: node tools\/pack\.mjs <firefox\|chrome\|edge>/);
  }
  assert.deepEqual(await readFile(join(root, "dist/edge/manifest.json")), edgeManifest);
  assert.deepEqual(await json(join(root, "extension/manifest.json")), sourceManifest);
});
