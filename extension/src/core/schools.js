// The schools LIVE mode can read. All of them run D2L Brightspace, so the same
// /d2l/api/ requests and /d2l/ page paths work on each one; only the origin and
// the name students know the site by differ.
//
//   origin   where /d2l/home lives. Waterloo's is in manifest host_permissions;
//            the rest are optional_host_permissions, asked for when picked.
//   aliases  other hostnames that serve the same site (tabs on them count as
//            that school's tabs, and the bridge runs there too)
//   home     the page "Open <system>" sends students to. Every Brightspace site
//            answers /d2l/home and sends a signed-out visitor to its own login.

export const SCHOOLS = [
  { id: "uwaterloo", name: "University of Waterloo", system: "Learn", origin: "https://learn.uwaterloo.ca" },
  { id: "uoguelph", name: "University of Guelph", system: "CourseLink", origin: "https://courselink.uoguelph.ca" },
  { id: "wlu", name: "Wilfrid Laurier University", system: "MyLearningSpace", origin: "https://mylearningspace.wlu.ca" },
  { id: "mcmaster", name: "McMaster University", system: "Avenue to Learn", origin: "https://avenue.cllmcmaster.ca" },
  { id: "queensu", name: "Queen's University", system: "onQ", origin: "https://onq.queensu.ca" },
  { id: "uwo", name: "Western University", system: "OWL", origin: "https://westernu.brightspace.com" },
  { id: "tmu", name: "Toronto Metropolitan University", system: "D2L Brightspace", origin: "https://courses.torontomu.ca", aliases: ["https://courses.ryerson.ca"] },
];

export const DEFAULT_SCHOOL = "uwaterloo";

export function schoolById(id) {
  return SCHOOLS.find((s) => s.id === id) || null;
}

/** The school the settings point at, or null when LIVE mode has no school picked yet. */
export function currentSchool(settings) {
  return schoolById(settings && settings.school);
}

/** Every origin a school's pages can load from. */
export function schoolOrigins(school) {
  return school ? [school.origin, ...(school.aliases || [])] : [];
}

/** Match patterns for chrome.permissions and content scripts. */
export function schoolPatterns(school) {
  return schoolOrigins(school).map((o) => `${o}/*`);
}

export function homeUrl(school) {
  return `${school.origin}${school.home || "/d2l/home"}`;
}

/** "Learn" when nothing is picked, so copy written before a school is known still reads. */
export function systemName(settings) {
  const s = currentSchool(settings);
  return s ? s.system : "Learn";
}
