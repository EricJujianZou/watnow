// Replaced when the extension is packaged for release.
// Demo mode is unreachable here: settings force live mode, so the catalog
// stays empty and DemoSource is never constructed.

import { startOfDay } from "../core/dates.js";

export { DEMO_SCRIPT } from "./fixtures.js";

export function learnUrl() {
  return "";
}

export function courseHomeUrl() {
  return "";
}

export function buildCatalog(settings, now = new Date()) {
  return {
    builtAt: now.toISOString(),
    builtDay: startOfDay(now).toISOString(),
    student: { name: "", initials: "" },
    term: "",
    learnBase: settings.learnBase,
    courses: [],
    items: [],
  };
}

export class DemoSource {
  constructor() {
    throw new Error("Demo mode is not available in this build.");
  }
}
