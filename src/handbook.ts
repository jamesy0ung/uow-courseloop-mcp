import {
  HandbookClient,
  NotFoundError,
  type ContentType,
  type PageKind,
  type SearchFilter,
  type SearchHit,
} from "./client.js";
import { describeFacets, FilterValueError, parseFilterCatalogue, resolveFacet, type FilterKey } from "./filters.js";
import {
  formatHit,
  hasFilter,
  hitType,
  matchOfferings,
  parseAreaOfStudy,
  parseAssessments,
  parseCourse,
  parseOfferingDetail,
  parseOfferings,
  parseSubject,
  preferExact,
  subjectLevel,
  type ItemType,
  type Offering,
  type OfferingFilter,
  type StructureGroup,
  type StructureItem,
} from "./parse.js";
import { evaluateRule, missingParts, parseRule, type CompletedSubject } from "./requisites.js";

interface MajorInfo {
  code: string;
  title: string;
  structure?: StructureGroup;
}

export class UserError extends Error {}

export type SearchType = ItemType | "all";

/** Search-page facets, by label (see list_search_filters). Values within one facet are ORed. */
export type SearchFilters = Partial<Record<Exclude<FilterKey, "aos_kind">, string[]>>;

export interface FindSubjectsOptions {
  area_of_study?: string;
  course?: string;
  query?: string;
  year?: number;
  session?: string;
  campus?: string;
  delivery?: string;
  levels?: number[];
  completed?: string[];
  exclude_group_work?: boolean;
  exclude_final_exam?: boolean;
  check_eligibility?: boolean;
  max_candidates?: number;
}

interface Candidate {
  code: string;
  title?: string;
  group?: string;
}

const yearFilter = (year: number): SearchFilter => ({
  filterField: "availableInYears",
  filterValue: [String(year)],
  isExactMatch: false,
});

const isGroupWork = (a: { group_or_individual?: string }) => /group/i.test(a.group_or_individual ?? "");
/** An exam that is not explicitly mid-session (handbook types are "Exam"; names vary, so match whole words only). */
const isFinalExam = (a: { name?: string; type?: string }) =>
  /\bexam(s|ination|inations)?\b/i.test(`${a.type ?? ""} ${a.name ?? ""}`) && !/mid[- ]?(session|semester|term)/i.test(a.name ?? "");

export const FIRST_YEAR = 2021;
export const PRE_2021_MESSAGE =
  `Handbook data before ${FIRST_YEAR} is not available: courses.uow.edu.au only serves ${FIRST_YEAR} onwards (server-side limitation). ` +
  `For older handbooks contact UOW directly.`;

/** Asks the user to pick one option; resolves undefined if they decline or the client can't ask. */
export type Chooser = (message: string, options: { value: string; label: string }[]) => Promise<string | undefined>;

export interface NeedsSelection {
  needs_selection: true;
  message: string;
  options: { value: string; label: string }[];
}

const KIND_TYPES: Record<PageKind, ItemType[]> = {
  courses: ["course"],
  subjects: ["subject"],
  aos: ["major", "minor"],
};

/** The default handbook year is always the current calendar year from the system clock. */
export const defaultYear = () => new Date().getFullYear();

/** Codes have no spaces and contain a digit: 766, CSIT110, MAJ40516. */
export function looksLikeCode(s: string): boolean {
  return /^[A-Za-z]{0,6}\d{2,6}[A-Za-z]?$/.test(s.trim());
}

function checkYear(year: number | undefined) {
  if (year !== undefined && year < FIRST_YEAR) throw new UserError(PRE_2021_MESSAGE);
}

interface Resolved {
  code: string;
  year: number;
  explicitYear: boolean;
  /** Latest year the search index lists this item under, used if the default year 404s. */
  fallbackYear?: number;
  resolved_from?: string;
  other_matches?: ReturnType<typeof formatHit>[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Both search APIs cap a page at this many results. */
const SEARCH_WINDOW = 100;

/**
 * One page of search results. The search orders equal scores differently on every request, so
 * separately fetched pages can repeat or skip hits at their edges. Pages within the first
 * SEARCH_WINDOW results are instead sliced from one (cached) request, so they never overlap.
 */
async function searchWindow(
  fetchPage: (from: number, size: number) => Promise<{ total: number; results: SearchHit[] }>,
  offset: number,
  limit: number,
) {
  if (offset + limit > SEARCH_WINDOW) {
    const page = await fetchPage(offset, limit);
    return { total: page.total, results: page.results.slice(0, limit) };
  }
  const page = await fetchPage(0, SEARCH_WINDOW);
  return { total: page.total, results: page.results.slice(offset, offset + limit) };
}

const offeringOption = (o: Offering) => ({
  value: o.offering,
  label: [o.campus, o.session, o.delivery].filter(Boolean).join(" · ") || o.offering,
});

export class Handbook {
  constructor(readonly client = new HandbookClient()) {}

  async search(
    query: string,
    opts: { year?: number; type?: SearchType; limit?: number; offset?: number; filters?: SearchFilters } = {},
  ) {
    checkYear(opts.year);
    const limit = opts.limit ?? 20;
    const active = Object.entries(opts.filters ?? {}).filter(([, v]) => v?.length) as [FilterKey, string[]][];
    if (active.length || (opts.type && opts.type !== "all")) {
      return this.facetedSearch(query, { ...opts, limit }, active);
    }
    if (!query.trim()) throw new UserError("Give a query, a type, or at least one filter.");
    const offset = opts.offset ?? 0;
    const { total, results } = await searchWindow((from, size) => this.client.search(query, opts.year ?? defaultYear(), size, from), offset, limit);
    const next = offset + results.length;
    return {
      query,
      type: "all",
      year: opts.year ?? defaultYear(),
      total,
      offset,
      ...(next < total ? { next_offset: next } : {}),
      results: results.map(formatHit),
    };
  }

  private async catalogue() {
    return parseFilterCatalogue(await this.client.searchConfig());
  }

  /** Every search facet and its allowed values, per content type, as the search page offers them. */
  async listFilters() {
    return {
      filters: describeFacets(await this.catalogue()),
      note: "Pass values by label (case-insensitive; a partial label matches every label containing it). aos = majors and minors.",
    };
  }

  /**
   * Resolve labelled filters to the search API's facet values, always restricted to one year.
   * Keys in `broad` match every label containing the text, even when one label matches exactly.
   */
  private async buildFilters(contenttype: ContentType, year: number, active: [FilterKey, string[]][], broad: FilterKey[] = []) {
    const facets = (await this.catalogue())[contenttype];
    const filters: SearchFilter[] = [yearFilter(year)];
    const applied: Partial<Record<FilterKey, string[]>> = {};
    for (const [key, values] of active) {
      const facet = facets[key];
      if (!facet) {
        const valid = Object.keys(facets).filter((k) => k !== "aos_kind");
        throw new UserError(`"${key}" cannot filter ${contenttype} searches. Filters available for ${contenttype}: ${valid.join(", ")}`);
      }
      try {
        const r = resolveFacet(facet, values, broad.includes(key));
        filters.push(r.filter);
        if (key !== "aos_kind") applied[key] = r.labels;
      } catch (err) {
        throw err instanceof FilterValueError ? new UserError(err.message) : err;
      }
    }
    return { filters, applied };
  }

  /** The site's Courses / Majors and Minors / Subjects tabs: server-side filtering and paging. */
  private async facetedSearch(
    query: string,
    opts: { year?: number; type?: SearchType; limit: number; offset?: number },
    active: [FilterKey, string[]][],
  ) {
    const year = opts.year ?? defaultYear();
    const notes: string[] = [];
    let type = opts.type ?? "all";
    if (type === "all") {
      type = "subject";
      notes.push("Filters apply per item type; searched subjects. Set type to search courses, majors or minors.");
    }
    const contenttype: ContentType = type === "major" || type === "minor" ? "aos" : type;
    const kind: [FilterKey, string[]][] = contenttype === "aos" ? [["aos_kind", [type === "major" ? "major" : "minor"]]] : [];
    const { filters, applied } = await this.buildFilters(contenttype, year, [...kind, ...active]);
    const offset = opts.offset ?? 0;
    const { total, results } = await searchWindow((from, size) => this.client.searchItems({ query, contenttype, filters, from, size }), offset, opts.limit);
    const next = offset + results.length;
    return {
      query,
      type,
      year,
      filters: applied,
      total,
      offset,
      ...(next < total ? { next_offset: next } : {}),
      results: results.map(formatHit),
      ...(notes.length ? { notes } : {}),
    };
  }

  /** Turn a code or a name into a code (+ year) for the given page kind. */
  async resolve(identifier: string, kind: PageKind, year?: number): Promise<Resolved> {
    checkYear(year);
    const id = identifier.trim();
    if (!id) throw new UserError("identifier must not be empty");
    const base = { year: year ?? defaultYear(), explicitYear: year !== undefined };
    if (looksLikeCode(id)) return { ...base, code: id.toUpperCase() };

    const types = KIND_TYPES[kind];
    const { results } = await this.client.search(id, base.year, 50);
    const hits = results.filter((h) => types.includes(hitType(h.contentTypeLabel) as ItemType));
    if (!hits.length) {
      throw new UserError(`No ${types.join("/")} matching "${id}". Try search_handbook to explore.`);
    }
    const want = id.toLowerCase();
    const best: SearchHit =
      hits.find((h) => h.title.toLowerCase() === want) ??
      hits.find((h) => `${h.code} ${h.title}`.toLowerCase() === want) ??
      hits[0];
    const hitYear = Number(best.uri.split("/")[2]);
    return {
      ...base,
      code: best.code,
      fallbackYear: Number.isFinite(hitYear) ? hitYear : undefined,
      resolved_from: id,
      other_matches: hits.filter((h) => h !== best).slice(0, 5).map(formatHit),
    };
  }

  private async page(kind: PageKind, identifier: string, year?: number, offering?: string) {
    const r = await this.resolve(identifier, kind, year);
    try {
      return { r, page: await this.client.getPage(kind, r.year, r.code, offering) };
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      if (!r.explicitYear && r.fallbackYear && r.fallbackYear !== r.year) {
        const page = await this.client.getPage(kind, r.fallbackYear, r.code, offering);
        return { r: { ...r, year: r.fallbackYear }, page };
      }
      throw new UserError(`${err.message}. Check the code or use search_handbook. (${PRE_2021_MESSAGE})`);
    }
  }

  private meta(r: Resolved, versionYear: number | undefined) {
    const notes: string[] = [];
    if (versionYear && versionYear !== r.year) {
      notes.push(`Requested ${r.year} but the handbook served the ${versionYear} version.`);
    }
    return {
      ...(r.resolved_from ? { resolved_from: r.resolved_from, other_matches: r.other_matches } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  // ---------- courses / areas of study ----------

  private async majorInfos(codes: string[], year: number): Promise<Map<string, MajorInfo & { credit_points?: number; rules?: string[] }>> {
    const infos = await mapLimit([...new Set(codes)], 4, async (code) => {
      try {
        const p = await this.client.getPage("aos", year, code);
        const a = parseAreaOfStudy(p.content, p.url);
        return { code, title: a.title as string, credit_points: a.credit_points, rules: a.rules, structure: a.structure };
      } catch {
        return { code, title: code };
      }
    });
    return new Map(infos.map((i) => [i.code, i]));
  }

  async getCourse(identifier: string, year?: number, opts: { includeStructure?: boolean; expandMajors?: boolean } = {}) {
    const { r, page } = await this.page("courses", identifier, year);
    const course = parseCourse(page.content, page.url, opts.includeStructure ?? true);
    let majors: Record<string, unknown> | undefined;
    if (opts.expandMajors && course.structure) {
      const codes = majorCodes(course.structure.variants);
      const infos = await this.majorInfos(codes, r.year);
      majors = Object.fromEntries([...infos].map(([code, m]) => [code, m]));
    }
    return { ...course, ...(majors ? { major_structures: majors } : {}), ...this.meta(r, course.version_year) };
  }

  async getAreaOfStudy(identifier: string, year?: number) {
    const { r, page } = await this.page("aos", identifier, year);
    const aos = parseAreaOfStudy(page.content, page.url);
    return { ...aos, ...this.meta(r, aos.version_year) };
  }

  // ---------- subjects ----------

  async getSubject(identifier: string, year?: number) {
    const { r, page } = await this.page("subjects", identifier, year);
    const subject = parseSubject(page.content, page.url);
    const { assessments } = parseAssessments(page.content);
    return {
      ...subject,
      year: r.year,
      assessments_common_to_all_offerings: assessments.map((a) => `${a.name} (${a.weight ?? "?"}%, ${a.group_or_individual ?? "?"})`),
      assessments_note: "Assessments can differ by offering; use get_subject_assessments with an offering for the complete list.",
      ...this.meta(r, subject.version_year),
    };
  }

  /**
   * Narrow offerings with the filter; if more than one remains, ask the user (via `choose`)
   * or hand the options back so the caller can ask.
   */
  private async pickOffering(
    code: string,
    year: number,
    pc: any,
    filter: OfferingFilter,
    choose?: Chooser,
  ): Promise<{ selected: Offering } | NeedsSelection> {
    const offerings = parseOfferings(pc);
    if (!offerings.length) throw new UserError(`${code} has no published offerings in ${year}.`);
    const candidates = hasFilter(filter) ? matchOfferings(offerings, filter) : offerings;
    if (!candidates.length) {
      throw new UserError(
        `No ${code} ${year} offering matches ${JSON.stringify(filter)}. Available: ${offerings.map((o) => o.offering).join("; ")}`,
      );
    }
    if (candidates.length === 1) return { selected: candidates[0] };
    const options = candidates.map(offeringOption);
    const message = `${code} has ${candidates.length} offerings in ${year}${hasFilter(filter) ? ` matching ${JSON.stringify(filter)}` : ""}. Which campus / session / delivery do you want?`;
    const picked = choose ? await choose(message, options) : undefined;
    const chosen = picked && candidates.find((c) => c.offering === picked);
    if (chosen) return { selected: chosen };
    return {
      needs_selection: true,
      message: `${message} Ask the user to choose, then call again with offering set to the chosen value.`,
      options,
    };
  }

  async getSubjectOffering(identifier: string, filter: OfferingFilter, year?: number, choose?: Chooser) {
    const { r, page } = await this.page("subjects", identifier, year);
    const base = parseSubject(page.content, page.url);
    const pick = await this.pickOffering(base.code, r.year, page.content, filter, choose);
    if ("needs_selection" in pick) return { code: base.code, title: base.title, year: r.year, ...pick };
    const detailPage = await this.client.getPage("subjects", r.year, base.code, pick.selected.offering);
    return {
      code: base.code,
      title: base.title,
      year: r.year,
      url: detailPage.url,
      contact_hours: pick.selected.contact_hours,
      ...parseOfferingDetail(detailPage.content, r.year),
      ...this.meta(r, base.version_year),
    };
  }

  /**
   * Assessments differ between offerings: the plain subject page only carries the ones common to
   * all offerings, so the full list always comes from the selected offering's page.
   */
  async getSubjectAssessments(
    identifier: string,
    filter: OfferingFilter,
    year?: number,
    choose?: Chooser,
    allOfferings = false,
  ) {
    const { r, page } = await this.page("subjects", identifier, year);
    const code: string = page.content.code;
    const head = { code, title: page.content.title as string, year: r.year };
    const meta = this.meta(r, Number(page.content.implementation_year) || undefined);
    const offerings = parseOfferings(page.content);
    const forOffering = async (o: Offering) => {
      const p = await this.client.getPage("subjects", r.year, code, o.offering);
      return { offering: o.offering, url: p.url, ...parseAssessments(p.content) };
    };
    const noneNote = (n: number) => (n ? {} : { message: "No assessment details are published for this offering." });

    if (!offerings.length) {
      const a = parseAssessments(page.content);
      return { ...head, url: page.url, ...a, ...noneNote(a.assessments.length), note: `No ${r.year} offerings are published; showing assessments common to all offerings.`, ...meta };
    }
    if (allOfferings) {
      const candidates = hasFilter(filter) ? matchOfferings(offerings, filter) : offerings;
      if (!candidates.length) throw new UserError(`No ${code} ${r.year} offering matches ${JSON.stringify(filter)}. Available: ${offerings.map((o) => o.offering).join("; ")}`);
      const by_offering = await mapLimit(candidates, 2, forOffering);
      return { ...head, by_offering, ...meta };
    }
    const pick = await this.pickOffering(code, r.year, page.content, filter, choose);
    if ("needs_selection" in pick) {
      const common = parseAssessments(page.content);
      return {
        ...head,
        ...pick,
        note: "Assessments can differ between offerings, so one must be chosen (or pass all_offerings=true). Assessments common to every offering are shown below.",
        common_assessments: common.assessments,
        ...meta,
      };
    }
    const result = await forOffering(pick.selected);
    return { ...head, ...result, ...noneNote(result.assessments.length), ...meta };
  }

  // ---------- eligibility ----------

  /** Look up credit points for each completed subject (unknown codes are reported, not fatal). */
  private async completedSubjects(codes: string[], year: number) {
    const unique = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    const found: (CompletedSubject & { title?: string })[] = [];
    const unrecognised: string[] = [];
    await mapLimit(unique, 4, async (code) => {
      for (const y of [year, defaultYear()]) {
        try {
          const p = await this.client.getPage("subjects", y, code);
          found.push({ code, credit_points: Number(p.content.credit_points) || 6, title: p.content.title });
          return;
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
        }
      }
      unrecognised.push(code);
    });
    found.sort((a, b) => a.code.localeCompare(b.code));
    return { found, unrecognised };
  }

  async checkSubjectEligibility(identifier: string, completed: string[], concurrent: string[] = [], year?: number) {
    const { r, page } = await this.page("subjects", identifier, year);
    const subject = parseSubject(page.content, page.url);
    const done = await this.completedSubjects(completed, r.year);
    const withConcurrent = await this.completedSubjects([...completed, ...concurrent], r.year);
    const { rules, excluded, eligible } = evaluateEligibility(subject, done.found, withConcurrent.found, [...completed, ...concurrent]);
    return {
      subject: `${subject.code} ${subject.title}`,
      year: r.year,
      eligible,
      summary:
        eligible === true
          ? rules.length ? "All enrolment rules are satisfied." : "No enrolment rules are listed for this subject."
          : eligible === false
            ? excluded.length ? `Excluded because of ${excluded.join(", ")}.` : `Not yet eligible: ${rules.flatMap((x) => x.missing).join("; ")}`
            : "Some rules could not be checked automatically; see 'missing'.",
      rules,
      exclusions: subject.exclusions,
      restrictions: subject.restrictions,
      completed_recognised: done.found,
      unrecognised_codes: withConcurrent.unrecognised,
      disclaimer: "Indicative only, computed from handbook rule text. Faculty approval or offering-specific rules may apply.",
    };
  }

  // ---------- subject finder ----------

  /** A major/minor by name, looked up within a course's structure when a course is given. */
  private async areaOfStudyFor(name: string, course: string | undefined, year?: number) {
    if (!course) return { aos: await this.getAreaOfStudy(name, year) };
    const c: any = await this.getCourse(course, year);
    const majors = [
      ...new Map(
        structureItems([...(c.structure?.variants ?? []), ...(c.structure?.common_groups ?? [])], "major_or_minor").map((m) => [m.code, m]),
      ).values(),
    ];
    const want = name.trim().toLowerCase();
    const matches =
      [majors.filter((m) => m.code.toLowerCase() === want || m.name.toLowerCase() === want)].find((x) => x.length) ??
      majors.filter((m) => m.name.toLowerCase().includes(want)).sort((a, b) => a.name.length - b.name.length);
    if (!matches.length) {
      throw new UserError(
        `${c.code} ${c.title} has no major or minor matching "${name}". Its majors/minors: ${majors.map((m) => `${m.code} ${m.name}`).join("; ")}`,
      );
    }
    return {
      aos: await this.getAreaOfStudy(matches[0].code, c.version_year ?? year),
      course: `${c.code} ${c.title}`,
      other_matches: matches.slice(1).map((m) => `${m.code} ${m.name}`),
    };
  }

  /** Subjects matching a free-text query and filters, via the faceted search (paged up to `max`). */
  private async searchCandidates(o: FindSubjectsOptions, year: number, max: number) {
    const active: [FilterKey, string[]][] = [];
    if (o.session) active.push(["session", [o.session]]);
    if (o.campus) active.push(["campus", [o.campus]]);
    if (o.delivery) active.push(["delivery", [o.delivery]]);
    if (o.levels?.length) active.push(["level", o.levels.map(String)]);
    if (!active.length && !o.query?.trim()) {
      throw new UserError("Give area_of_study, course, query, or at least one of session / campus / delivery / level.");
    }
    // Offerings are re-checked by substring below, so search broadly: "Autumn" must also find "Spring/Autumn".
    const { filters } = await this.buildFilters("subject", year, active, ["session", "campus", "delivery"]);
    const hits: SearchHit[] = [];
    let total = 0;
    do {
      const page = await this.client.searchItems({ query: o.query ?? "", contenttype: "subject", filters, from: hits.length, size: SEARCH_WINDOW });
      total = page.total;
      hits.push(...page.results);
      if (!page.results.length) break;
    } while (hits.length < Math.min(total, max));
    return { candidates: hits.map((h): Candidate => ({ code: h.code, title: h.title.trim() })), total };
  }

  /**
   * Answer questions like "a Cyber Security major subject in the Bachelor of Computer Science that I
   * haven't taken, offered in Autumn at Wollongong, without group work". Candidates come from a
   * major/minor or course structure (or the faceted search); each is then checked against its
   * real offerings (session × campus × delivery together) and, if asked, each matching offering's
   * assessments and the student's prerequisites.
   */
  async findSubjects(o: FindSubjectsOptions) {
    checkYear(o.year);
    const year = o.year ?? defaultYear();
    const max = o.max_candidates ?? 30;
    const notes: string[] = [];
    let source: Record<string, unknown>;
    let pool: Candidate[];

    if (o.area_of_study) {
      const { aos, course, other_matches } = await this.areaOfStudyFor(o.area_of_study, o.course, o.year);
      pool = structureItems(aos.structure ? [aos.structure] : [], "subject").map((s) => ({ code: s.code, title: s.name, group: s.group }));
      source = { area_of_study: `${aos.code} ${aos.title}`, url: aos.url, ...(course ? { course } : {}), ...(other_matches?.length ? { other_matches } : {}) };
      if (aos.rules?.length) source.rules = aos.rules;
    } else if (o.course) {
      const c: any = await this.getCourse(o.course, o.year);
      let variants: StructureGroup[] = c.structure?.variants ?? [];
      const campus = o.campus?.toLowerCase();
      const forCampus = campus ? variants.filter((v) => v.title.toLowerCase().includes(campus)) : [];
      if (forCampus.length) variants = forCampus;
      pool = structureItems([...variants, ...(c.structure?.common_groups ?? [])], "subject").map((s) => ({ code: s.code, title: s.name, group: s.group }));
      source = { course: `${c.code} ${c.title}`, url: c.url, structures: variants.map((v) => v.title) };
      notes.push("Only subjects listed directly in the course structure were considered; pass area_of_study to search within a major or minor.");
    } else {
      const s = await this.searchCandidates(o, year, max);
      pool = s.candidates;
      source = { search: o.query ?? "", matching_subjects: s.total };
    }

    if (o.query && (o.area_of_study || o.course)) {
      const q = o.query.toLowerCase();
      pool = pool.filter((c) => `${c.code} ${c.title ?? ""}`.toLowerCase().includes(q));
    }
    const completed = new Set((o.completed ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean));
    const rejected: { code: string; title?: string; reason: string }[] = [];
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const c of pool) {
      if (seen.has(c.code)) continue;
      seen.add(c.code);
      const level = subjectLevel(c.code);
      if (completed.has(c.code)) rejected.push({ code: c.code, title: c.title, reason: "already completed" });
      else if (o.levels?.length && (!level || !o.levels.includes(level))) rejected.push({ code: c.code, title: c.title, reason: `level ${level ?? "unknown"}` });
      else candidates.push(c);
    }
    const checked = candidates.slice(0, max);
    if (candidates.length > max) {
      notes.push(`Only the first ${max} of ${candidates.length} candidates were checked; narrow the search or raise max_candidates.`);
    }

    const filter: OfferingFilter = { session: o.session, campus: o.campus, delivery: o.delivery };
    const wantAssessments = Boolean(o.exclude_group_work || o.exclude_final_exam);
    const done = !o.check_eligibility ? undefined : completed.size ? await this.completedSubjects([...completed], year) : { found: [], unrecognised: [] };

    const evaluated = await mapLimit(checked, 2, async (c) => {
      let r: Resolved;
      let page: { url: string; content: any };
      try {
        ({ r, page } = await this.page("subjects", c.code, o.year));
      } catch (err) {
        if (err instanceof UserError || err instanceof NotFoundError) return { reject: { ...c, reason: `not in the ${year} handbook` } };
        throw err;
      }
      const subject = parseSubject(page.content, page.url);
      const all = subject.offerings ?? [];
      let offerings = hasFilter(filter) ? preferExact(matchOfferings(all, filter), filter) : all;
      if (!offerings.length) {
        const available = all.map((x) => x.offering).join("; ") || "none";
        return { reject: { ...c, title: subject.title, reason: `no ${r.year} offering matches ${JSON.stringify(filter)} (offered: ${available})` } };
      }

      const caveats: string[] = [];
      let assessments: string[] | undefined;
      if (wantAssessments) {
        const per = await mapLimit(offerings, 2, async (off) => {
          let a: ReturnType<typeof parseAssessments> | undefined;
          try {
            a = parseAssessments((await this.client.getPage("subjects", r.year, subject.code, off.offering)).content);
          } catch (err) {
            if (!(err instanceof NotFoundError)) throw err;
            return { off, a, problems: [] as string[] };
          }
          const problems = [
            ...(o.exclude_group_work ? a.assessments.filter(isGroupWork).map((x) => `group work: ${x.name} (${x.weight ?? "?"}%)`) : []),
            ...(o.exclude_final_exam ? a.assessments.filter(isFinalExam).map((x) => `exam: ${x.name} (${x.weight ?? "?"}%)`) : []),
          ];
          return { off, a, problems };
        });
        const good = per.filter((x) => !x.problems.length);
        if (!good.length) {
          return { reject: { ...c, title: subject.title, reason: [...new Set(per.flatMap((x) => x.problems))].join("; ") } };
        }
        offerings = good.map((x) => x.off);
        const first = good.find((x) => x.a?.assessments.length)?.a;
        if (first) {
          assessments = first.assessments.map((x) => `${x.name} (${x.weight ?? "?"}%, ${x.group_or_individual ?? "?"}, ${x.type ?? "?"})`);
          if (first.warning) caveats.push(first.warning);
        }
        const unknown = good.filter((x) => !x.a?.assessments.length).map((x) => x.off.offering);
        if (unknown.length) {
          caveats.push(`No assessments are published for ${unknown.join("; ")}, so group work / exams could not be ruled out there.`);
        }
      }

      let eligibility: Record<string, unknown> | undefined;
      if (done) {
        const e = evaluateEligibility(subject, done.found, done.found, [...completed]);
        eligibility = {
          eligible: e.eligible,
          ...(e.excluded.length ? { excluded_by: e.excluded } : {}),
          ...(e.eligible === true ? {} : { missing: e.rules.flatMap((x: { missing: string[] }) => x.missing) }),
        };
      }
      return {
        result: {
          code: subject.code,
          title: subject.title,
          ...(c.group ? { group: c.group } : {}),
          credit_points: subject.credit_points,
          url: subject.url,
          offerings: offerings.map((x) => x.offering),
          ...(assessments ? { assessments } : {}),
          ...(eligibility ?? {}),
          ...(caveats.length ? { caveats } : {}),
        },
      };
    });

    const results = evaluated.flatMap((e) => ("result" in e && e.result ? [e.result] : []));
    rejected.push(...evaluated.flatMap((e) => ("reject" in e && e.reject ? [e.reject] : [])));
    if (wantAssessments) notes.push("Assessments come from the handbook and can change; confirm in the subject outline.");
    if (done?.unrecognised.length) notes.push(`Completed codes not found in the handbook: ${done.unrecognised.join(", ")}`);
    return {
      year,
      source,
      criteria: compactCriteria(o),
      matches: results.length,
      results,
      ruled_out: rejected.map((x) => ({ code: x.code, ...(x.title ? { title: x.title } : {}), reason: x.reason })),
      ...(notes.length ? { notes } : {}),
    };
  }
}

function compactCriteria(o: FindSubjectsOptions) {
  const { area_of_study: _a, course: _c, max_candidates: _m, ...rest } = o;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length)));
}

function evaluateEligibility(
  subject: ReturnType<typeof parseSubject>,
  done: CompletedSubject[],
  withConcurrent: CompletedSubject[],
  codes: string[],
) {
  const rules = (subject.enrolment_rules ?? []).map((rule: { type?: string; rule: string }) => {
    const isCo = /co-?requisite/i.test(rule.type ?? "");
    const tree = parseRule(rule.rule);
    const result = evaluateRule(tree, isCo ? withConcurrent : done);
    return { type: rule.type, rule: rule.rule, met: result.met, missing: missingParts(result), evaluation: result };
  });
  const exclusionText = `${subject.exclusions ?? ""}\n${subject.restrictions ?? ""}`.toUpperCase();
  const excluded = [...new Set(codes.map((c) => c.trim().toUpperCase()))]
    .filter((c) => /^[A-Z0-9]+$/.test(c) && new RegExp(`(?<![A-Z0-9])${c}(?![A-Z0-9])`).test(exclusionText));
  const vals = rules.map((x: { met: boolean | null }) => x.met);
  const eligible: boolean | null = excluded.length ? false : vals.includes(false) ? false : vals.includes(null) ? null : true;
  return { rules, excluded, eligible };
}

/** Every item of the given kind in a structure tree, tagged with the group it sits in. */
function structureItems(groups: StructureGroup[], kind: StructureItem["kind"]): (StructureItem & { group: string })[] {
  const out: (StructureItem & { group: string })[] = [];
  const walk = (g: StructureGroup) => {
    for (const it of g.items ?? []) if (it.kind === kind) out.push({ ...it, group: g.title });
    (g.groups ?? []).forEach(walk);
  };
  groups.forEach(walk);
  return out;
}

function majorCodes(groups: StructureGroup[]): string[] {
  const out: string[] = [];
  const walk = (g: StructureGroup) => {
    for (const it of g.items ?? []) if (it.kind === "major_or_minor") out.push(it.code);
    (g.groups ?? []).forEach(walk);
  };
  groups.forEach(walk);
  return [...new Set(out)];
}
