import type { ContentType, SearchFilter } from "./client.js";

/**
 * The handbook's search page (courses.uow.edu.au/search) is configured by a list of facets per
 * tab: Courses, Majors/Minors (content type "aos") and Subjects. Each facet names a search-index
 * field and the values it accepts, mostly opaque ids ("Wollongong" = d58bdcf6…). This maps the
 * facets to friendly parameter names so callers can pass labels instead of ids.
 */
export type FilterKey =
  | "session"
  | "campus"
  | "delivery"
  | "level"
  | "faculty"
  | "study_area"
  | "schedule"
  | "award_type"
  | "course_type"
  | "course_of_study"
  | "aos_kind";

const FIELD_KEYS: Record<string, FilterKey> = {
  teachingPeriod: "session",
  location: "campus",
  mode: "delivery",
  subjectLevel: "level",
  academicOrg: "faculty",
  handbookTags: "study_area",
  csTags: "schedule",
  studyLevelValue: "award_type",
  courseType: "course_type",
  courseOfStudy: "course_of_study",
  level: "aos_kind",
};

export interface FilterValue {
  label: string;
  value: string;
}

export interface Facet {
  key: FilterKey;
  heading: string;
  field: string;
  isExactMatch: boolean;
  values: FilterValue[];
}

export type FilterCatalogue = Record<ContentType, Partial<Record<FilterKey, Facet>>>;

const TAB_TYPES: [RegExp, ContentType][] = [
  [/subject/i, "subject"],
  [/aos/i, "aos"],
  [/course/i, "course"],
];

/** Faculty values nest schools in sub_list; flatten so either can be chosen. */
function flatten(values: any[]): FilterValue[] {
  return (values ?? []).flatMap((v) => [
    { label: String(v.label ?? "").trim(), value: String(v.value) },
    ...flatten(v.sub_list ?? []),
  ]);
}

export function parseFilterCatalogue(config: any): FilterCatalogue {
  const out: FilterCatalogue = { course: {}, subject: {}, aos: {} };
  for (const tab of config.sub_modules ?? []) {
    const ct = TAB_TYPES.find(([re]) => re.test(tab.module_name ?? ""))?.[1];
    if (!ct) continue;
    for (const m of tab.sub_modules ?? []) {
      const fm = m.searchFilter_field_map ?? {};
      const field: string | undefined = fm.filter_field?.data_field;
      const key = field ? FIELD_KEYS[field] : undefined;
      if (!field || !key) continue;
      out[ct][key] = {
        key,
        heading: fm.main_heading?.data_field ?? field,
        field,
        isExactMatch: fm.filter_default?.data_field === "exact",
        values: flatten(fm.filter_values?.data_field).filter((v) => v.label && v.value),
      };
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export class FilterValueError extends Error {}

/** The search API fails with HTTP 500 on values containing "/" (the "Spring/Autumn" session). */
const searchable = (v: FilterValue) => !v.value.includes("/");

/**
 * Turn user-supplied labels into facet values: an exact label (or raw value) wins; otherwise every
 * label containing the text matches ("Liverpool" -> Liverpool and UOW College Liverpool). With
 * `broad`, every label containing the text matches even when one matches exactly.
 */
export function resolveFacet(facet: Facet, wanted: string[], broad = false): { filter: SearchFilter; labels: string[] } {
  const picked: FilterValue[] = [];
  const name = facet.heading.replace(/^Filter by /, "").toLowerCase();
  for (const w of wanted) {
    const n = norm(w);
    const exact = facet.values.filter((v) => norm(v.label) === n || v.value === w);
    const partial = facet.values.filter((v) => norm(v.label).includes(n) && !exact.includes(v));
    const found = exact.length && !broad ? exact : [...exact, ...partial];
    const matches = found.filter(searchable);
    if (n && found.length && !matches.length) {
      throw new FilterValueError(
        `The handbook's search fails on the ${name} "${found.map((v) => v.label).join('", "')}" (a fault on courses.uow.edu.au), so it can't be filtered on. ` +
          "Use find_subjects, which checks each subject's real offerings, or filter on the individual sessions.",
      );
    }
    if (!n || !matches.length) {
      throw new FilterValueError(`"${w}" is not a valid ${name}. Valid values: ${facet.values.filter(searchable).map((v) => v.label).join(", ")}`);
    }
    for (const m of matches) if (!picked.some((p) => p.value === m.value)) picked.push(m);
  }
  return {
    filter: { filterField: facet.field, filterValue: picked.map((p) => p.value), isExactMatch: facet.isExactMatch },
    labels: picked.map((p) => p.label),
  };
}

/** Facet keys that make sense for each content type, as shown in the tool description. */
export function describeFacets(cat: FilterCatalogue) {
  return Object.fromEntries(
    (Object.keys(cat) as ContentType[]).map((ct) => [
      ct,
      Object.fromEntries(Object.values(cat[ct]).flatMap((f) => (f ? [[f.key, f.values.filter(searchable).map((v) => v.label)]] : []))),
    ]),
  );
}
