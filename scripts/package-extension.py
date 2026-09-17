#!/usr/bin/env python3
"""Zip the extension for testers or a Chrome Web Store upload.

Usage: python3 scripts/package-extension.py [--bump patch|minor]

The zip is the tester build: it reads real Learn only, hides the demo, and
drops the mock Learn permissions and demo shortcuts from the manifest. The
extension folder itself stays the demo build for recordings.

Chrome only offers an update when the manifest version goes up, so bump it
before every release you upload to the store.
"""
import argparse
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
DIST = ROOT / "dist"
SKIP = {".DS_Store", "Thumbs.db"}
BUILD_FLAG = "src/core/build.js"
MOCK_HOSTS = ("http://localhost", "http://127.0.0.1")


def tester_manifest(manifest):
    m = json.loads(json.dumps(manifest))
    m["host_permissions"] = [h for h in m["host_permissions"] if not h.startswith(MOCK_HOSTS)]
    for cs in m["content_scripts"]:
        cs["matches"] = [h for h in cs["matches"] if not h.startswith(MOCK_HOSTS)]
    m.pop("commands", None)
    return json.dumps(m, indent=2) + "\n"


def bump(version, part):
    major, minor, patch = (int(x) for x in version.split("."))
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bump", choices=["patch", "minor"])
    args = parser.parse_args()

    manifest_path = EXT / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if args.bump:
        manifest["version"] = bump(manifest["version"], args.bump)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    DIST.mkdir(exist_ok=True)
    out = DIST / f"watnow-{manifest['version']}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(EXT.rglob("*")):
            if not path.is_file() or path.name in SKIP or path.name.startswith("."):
                continue
            rel = path.relative_to(EXT).as_posix()
            if rel == "manifest.json":
                zf.writestr(rel, tester_manifest(manifest))
            elif rel == BUILD_FLAG:
                flag = path.read_text()
                assert "TESTER_BUILD = false" in flag, "build flag line changed"
                zf.writestr(rel, flag.replace("TESTER_BUILD = false", "TESTER_BUILD = true"))
            else:
                zf.write(path, rel)
    print(out)


if __name__ == "__main__":
    main()
