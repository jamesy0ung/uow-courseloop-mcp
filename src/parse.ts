import { BASE_URL, type SearchHit } from "./client.js";

// ---------- helpers ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function htmlToText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  return html
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** CourseLoop reference fields look like {label,value} or {value,cl_id,key}. */
function ref(x: any): string | undefined {
  if (x == null) return undefined;
  if (typeof x === "string") return x || undefined;
  return (x.label ?? x.value) || undefined;
}

function num(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : parseFloat(String(x ?? ""));
  return Number.isFinite(n) ? n : undefined;
}

function years(pc: any): number[] {
  return (pc.yearSwitcher ?? []).map((y: any) => Number(y.value)).filter(Number.isFinite);
}

function byOrder(a: any, b: any) {
  return (num(a.order) ?? num(a.number) ?? 0) - (num(b.order) ?? num(b.number) ?? 0);
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete o[k];
  }
  return o;
}

// ---------- search ----------

export type ItemType = "course" | "subject" | "major" | "minor";

export function hitType(label: string): ItemType | "other" {
  const l = label.toLowerCase();
  if (l === "course") return "course";
  if (l === "subject") return "subject";
  if (l.startsWith("major")) return "major";
  if (l === "minor") return "minor";
  return "other";
}

export function formatHit(h: SearchHit) {
  return compact({
    code: h.code,
    title: h.title,
    type: hitType(h.contentTypeLabel),
    study_level: h.studyLevel,
    locations: h.locationDisplay?.replace(/^Offered in /, ""),
    year: num(h.uri.split("/")[2]),
    url: BASE_URL + h.uri,
    suspended_or_discontinued: h.isSuspendedOrDiscontinued === "true" ? true : undefined,
  });
}

// ---------- structure (courses + areas of study) ----------

export interface StructureItem {
  code: string;
  name: string;
  kind: "subject" | "major_or_minor" | "course" | "other";
  credit_points?: number;
  url?: string;
}
export interface StructureGroup {
  title: string;
  /** Handbook category: Core, Elective, Capstone, Major Study / Specialisation, Course… */
  category?: string;
  /** How this group combines with its siblings in the handbook (AND / OR). */
  connector?: string;
  credit_points?: number;
  description?: string;
  items?: StructureItem[];
  groups?: StructureGroup[];
  note?: string;
}

function structureItem(r: any): StructureItem {
  const url: string = r.academic_item_url ?? "";
  const seg = url.split("/")[1];
  return compact({
    code: r.academic_item_code,
    name: r.academic_item_name,
    kind: seg === "subjects" ? "subject" : seg === "aos" ? "major_or_minor" : seg === "courses" ? "course" : "other",
    credit_points: num(r.academic_item_credit_points),
    url: url ? BASE_URL + url : undefined,
  }) as StructureItem;
}

function structureGroup(node: any): StructureGroup {
  const rels = [...(node.relationship ?? []), ...(node.dynamic_relationship ?? [])].sort(byOrder);
  return compact({
    title: (node.title ?? node.name ?? "").trim(),
    category: ref(node.vertical_grouping),
    connector: ref(node.parent_connector),
    credit_points: num(node.credit_points),
    description: htmlToText(node.description) || undefined,
    items: rels.map(structureItem),
    groups: (node.container ?? []).map(structureGroup),
  }) as StructureGroup;
}

export function parseStructure(cs: any): StructureGroup | undefined {
  if (!cs || typeof cs !== "object") return undefined;
  return structureGroup(cs);
}

const isEmpty = (g: StructureGroup) => !g.items?.length && !g.groups?.length;
const cpSum = (gs: StructureGroup[]) => gs.reduce((s, g) => s + (g.credit_points ?? 0), 0);

export interface CourseStructure {
  credit_points?: number;
  /** Alternative structures (normally one per campus); a student completes exactly one. */
  variants: StructureGroup[];
  /** Groups required regardless of variant (only when they could not be attached to a variant). */
  common_groups?: StructureGroup[];
}

/**
 * The handbook models campus-specific structures as top-level containers joined by OR.
 * Top-level AND containers are shared requirements, except that CourseLoop sometimes lists a
 * variant's groups as top-level siblings (e.g. 766's UOW Malaysia KDU variant is empty and is
 * followed by "Core" 36cp + "Electives" 36cp = its 72cp). We attach those when the maths fits.
 */
export function courseStructure(root: StructureGroup | undefined): CourseStructure | undefined {
  if (!root) return undefined;
  const top = root.groups ?? [];
  // A pathway into another course (e.g. Honours) is an alternative even when tagged AND.
  const isVariant = (g: StructureGroup) =>
    g.connector === "OR" || g.category === "Course" || (g.items ?? []).some((i) => i.kind === "course");
  const variants = top.filter(isVariant);
  let common = top.filter((g) => !isVariant(g));
  if (variants.length < 2) {
    return { credit_points: root.credit_points, variants: [{ ...root, title: root.title || "Structure" }] };
  }
  const empty = variants.filter((v) => isEmpty(v) && v.credit_points);
  if (empty.length === 1 && common.length && cpSum(common) === empty[0].credit_points) {
    empty[0].groups = common;
    empty[0].note = `Groups ${common.map((g) => `"${g.title}"`).join(" and ")} are listed by the handbook as top-level siblings after this variant; attached here because their credit points (${cpSum(common)}) make up its total.`;
    common = [];
  }
  return compact({ credit_points: root.credit_points, variants, common_groups: common }) as CourseStructure;
}

function outcomes(list: any[] | undefined) {
  return [...(list ?? [])].sort(byOrder).map((o) =>
    compact({ code: o.code || (o.number ? `LO${o.number}` : undefined), description: htmlToText(o.description) }),
  );
}

/** Course / AOS rule text ("a) 96 credit points of core…"), in handbook order. */
export function parseRules(pc: any): string[] {
  const sorted = (list: any[] | undefined) => [...(list ?? [])].sort(byOrder);
  return [...sorted(pc.Rules), ...sorted(pc.structure_addtional_comments)]
    .map((r) => htmlToText(r.description))
    .filter(Boolean);
}

// ---------- course ----------

export function parseCourse(pc: any, url: string, includeStructure = true) {
  return compact({
    type: "course",
    code: pc.code,
    title: pc.title,
    version_year: num(pc.implementation_year),
    available_years: years(pc),
    url,
    study_level: ref(pc.study_level),
    credit_points: num(pc.credit_points),
    full_time_duration: pc.full_time_duration,
    part_time_duration: pc.part_time_duration,
    faculty: ref(pc.school),
    campuses: (pc.offering ?? [])
      .filter((o: any) => o.publish !== "false")
      .map((o: any) => compact({ offering: o.display_name, campus: ref(o.location), status: ref(o.status) })),
    description: htmlToText(pc.description),
    learning_outcomes: outcomes(pc.learning_outcomes),
    rules: parseRules(pc),
    structure: includeStructure ? courseStructure(parseStructure(pc.curriculumStructure)) : undefined,
  });
}

// ---------- area of study ----------

export function parseAreaOfStudy(pc: any, url: string) {
  return compact({
    type: hitType(pc.contentTypeLabel ?? ""),
    code: pc.code,
    title: pc.title,
    version_year: num(pc.implementation_year),
    available_years: years(pc),
    url,
    credit_points: num(pc.credit_points),
    faculty: ref(pc.school),
    school: ref(pc.academic_org),
    description: htmlToText(pc.description),
    learning_outcomes: outcomes(pc.learning_outcomes),
    rules: parseRules(pc),
    structure: parseStructure(pc.curriculumStructure),
  });
}

// ---------- subject ----------

export interface Offering {
  offering: string;
  campus?: string;
  session?: string;
  delivery?: string;
  contact_hours?: string;
}

export function parseOfferings(pc: any): Offering[] {
  return (pc.unit_offering ?? [])
    .filter((o: any) => o.publish !== "false" && o.offered !== "false")
    .map((o: any) =>
      compact({
        offering: o.display_name,
        campus: ref(o.location),
        session: ref(o.teaching_period),
        delivery: ref(o.attendance_mode),
        contact_hours: o.engagement_hours || undefined,
      }) as Offering,
    );
}

function enrolmentRules(rules: any[] | undefined) {
  return (rules ?? [])
    .sort(byOrder)
    .map((r) => compact({ type: r.type_label ?? ref(r.type), rule: htmlToText(r.description) }))
    .filter((r) => r.rule);
}

/** "CSIT214" -> 200, "MIR 903" -> 900; undefined when the code has no level digit. */
export function subjectLevel(code: string): number | undefined {
  const m = code.match(/^[A-Za-z]+ ?(\d)\d\d/);
  return m ? Number(m[1]) * 100 : undefined;
}

export function parseSubject(pc: any, url: string) {
  const description = htmlToText(pc.description) || htmlToText(pc.unit_description?.[0]?.description);
  return compact({
    type: "subject",
    code: pc.code,
    title: pc.title,
    version_year: num(pc.implementation_year),
    available_years: years(pc),
    url,
    credit_points: num(pc.credit_points),
    level: ref(pc.level),
    study_level: ref(pc.study_level),
    faculty: ref(pc.school),
    school: ref(pc.academic_org),
    description,
    enrolment_rules: enrolmentRules(pc.enrolment_rules_applied_to_all),
    prerequisites: htmlToText(pc.pre_requisites) || undefined,
    exclusions: htmlToText(pc.exclusions) || undefined,
    restrictions: htmlToText(pc.restrictions_exclusions) || undefined,
    equivalent_subjects: (pc.equivalent_subjects ?? []).map((e: any) =>
      compact({ subject: e.associated_ai_display, relationship: ref(e.association_dependent_type) ?? ref(e.association_type) }),
    ),
    learning_outcomes: outcomes(pc.unit_learning_outcomes),
    offerings: parseOfferings(pc),
  });
}

/** Extra data only present when the page is fetched with ?offering=<display_name>. */
export function parseOfferingDetail(pc: any, year: number) {
  // Never substitute a different year for enrolment or census dates.
  const instances = [...(pc.teaching_period_instances ?? [])].sort((a, b) => (a.learning_start_date ?? "").localeCompare(b.learning_start_date ?? ""));
  const sameYear = instances.filter((t) => num(t.academic_year) === year);

  const staff = (list: any[] | undefined) =>
    (list ?? []).sort(byOrder).map((s) => compact({ name: ref(s.user), role: ref(s.contact_role), email: s.contact_email || undefined }));
  return compact({
    offering: pc.display_name,
    campus: ref(pc.location),
    session: ref(pc.teaching_period),
    delivery: ref(pc.attendance_mode),
    sessions_note: sameYear.length ? undefined : `Session dates are not published for ${year}.`,
    sessions: sameYear.map((t: any) =>
      compact({
        session: ref(t.teaching_period),
        academic_year: t.academic_year,
        start_date: t.learning_start_date,
        end_date: t.learning_end_date,
        census_date: t.census_date,
        status: ref(t.status),
      }),
    ),
    timetable_class: pc.timetable_offering || undefined,
    quota: num(pc.quota_number),
    enrolment_rules: enrolmentRules(pc.enrolment_rules),
    course_restrictions: htmlToText(pc.course_restrictions) || undefined,
    comments: htmlToText(pc.comments) || undefined,
    additional_information: htmlToText(pc.additional_information) || undefined,
    coordinators: staff(pc.academic_staff_coordinators),
    lecturers: staff(pc.academic_staff_lecturers),
    tutors: staff(pc.academic_staff_tutors),
  });
}

// ---------- offerings matching ----------

export interface OfferingFilter {
  offering?: string;
  session?: string;
  campus?: string;
  delivery?: string;
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function hasFilter(f: OfferingFilter): boolean {
  return Boolean(f.offering || f.session || f.campus || f.delivery);
}

export function matchOfferings(offerings: Offering[], f: OfferingFilter): Offering[] {
  if (f.offering) {
    const exact = offerings.filter((o) => norm(o.offering) === norm(f.offering));
    if (exact.length) return exact;
  }
  const test = (field: string | undefined, want: string | undefined) => !want || norm(field).includes(norm(want));
  return offerings.filter(
    (o) =>
      test(o.offering, f.offering) &&
      test(o.session, f.session) &&
      test(o.campus, f.campus) &&
      test(o.delivery, f.delivery),
  );
}

/**
 * Substring matching lets "Wollongong" also match "UOW Online Wollongong"; when some offerings
 * match a field exactly, keep only those.
 */
export function preferExact(offerings: Offering[], f: OfferingFilter): Offering[] {
  let out = offerings;
  for (const key of ["session", "campus", "delivery"] as const) {
    if (!f[key]) continue;
    const exact = out.filter((o) => norm(o[key]) === norm(f[key]));
    if (exact.length) out = exact;
  }
  return out;
}

// ---------- assessments ----------

/**
 * Without ?offering= the handbook only returns assessments common to every offering;
 * offering-specific ones (applies_to lists offerings) appear only on the offering's page.
 */
export function parseAssessments(pc: any) {
  const all = [...(pc.assessments ?? [])].sort((a, b) => (num(a.assessment_number) ?? 0) - (num(b.assessment_number) ?? 0));
  const assessments = all.map((a) => {
    const instanceNames: string[] = (a.instances ?? [])
      .map((i: any) => (typeof i === "string" ? i : (ref(i.offering) ?? ref(i) ?? i.display_name)))
      .filter(Boolean);
    const appliesToAll = a.applies_to_all_instances !== "false" || instanceNames.length === 0;
    return compact({
      number: num(a.assessment_number),
      name: a.assessment_name,
      weight: num(a["weighting_%"]),
      weight_note: htmlToText(a.weighting_description) || undefined,
      group_or_individual: ref(a.individual_group),
      type: ref(a.assessment_type),
      learning_outcomes: (a.subject_learning_outcome ?? []).map((l: any) => l.value).filter(Boolean).sort(),
      secure_assessment: ref(a.secure_assessment),
      security_note: htmlToText(a.security_description) || undefined,
      applies_to: appliesToAll ? "all offerings" : instanceNames,
    });
  });
  const total = assessments.reduce((s, a) => s + (a.weight ?? 0), 0);
  // Some handbook entries (often partner campuses) only publish part of the assessment plan.
  const warning =
    assessments.length && total !== 100
      ? `Published weights sum to ${total}%, not 100%: the handbook entry for this offering looks incomplete. Check the subject outline for the full assessment plan.`
      : undefined;
  return { total_weight: total, assessments, ...(warning ? { warning } : {}) };
}
