// src/core/schools.js against extension/manifest.json: every origin a school
// can load from has to be in the manifest, or the browser never asks for it
// and the read fails without a prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { SCHOOLS, DEFAULT_SCHOOL, schoolOrigins } from "../extension/src/core/schools.js";

const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const required = new Set(manifest.host_permissions);
const optional = new Set(manifest.optional_host_permissions);

test("every school id is unique", () => {
  const ids = SCHOOLS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the default school is listed first, which the panel's picker counts on", () => {
  assert.equal(SCHOOLS[0].id, DEFAULT_SCHOOL);
});

test("the default school is in host_permissions, every other origin is optional", () => {
  for (const school of SCHOOLS) {
    for (const origin of schoolOrigins(school)) {
      const pattern = `${origin}/*`;
      if (school.id === DEFAULT_SCHOOL) assert.ok(required.has(pattern), `${pattern} should be a required host permission`);
      else assert.ok(optional.has(pattern), `${pattern} should be an optional host permission`);
    }
  }
});

test("the manifest asks for nothing but the schools and Crowdmark", () => {
  const expected = new Set(["https://app.crowdmark.com/*"]);
  for (const school of SCHOOLS.filter((s) => s.id !== DEFAULT_SCHOOL)) for (const origin of schoolOrigins(school)) expected.add(`${origin}/*`);
  assert.deepEqual([...optional].sort(), [...expected].sort());
});

test("every origin is https with no path", () => {
  for (const school of SCHOOLS) {
    for (const origin of schoolOrigins(school)) {
      const u = new URL(origin);
      assert.equal(u.protocol, "https:");
      assert.equal(u.origin, origin, `${origin} should be a bare origin`);
    }
  }
});
