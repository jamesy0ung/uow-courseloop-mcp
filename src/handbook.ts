import { HandbookClient, NotFoundError, type PageKind, type SearchHit } from "./client.js";
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
  type ItemType,
  type Offering,
  type OfferingFilter,
  type StructureGroup,
} from "./parse.js";
import { evaluateRule, missingParts, parseRule, type CompletedSubject } from "./requisites.js";

interface MajorInfo {
  code: string;
  title: string;
  structure?: StructureGroup;
}

export class UserError extends Error {}

export type SearchType = ItemType | "all";

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

const offeringOption = (o: Offering) => ({
  value: o.offering,
  label: [o.campus, o.session, o.delivery].filter(Boolean).join(" · ") || o.offering,
});

export class Handbook {
  constructor(readonly client = new HandbookClient()) {}

  async search(query: string, opts: { year?: number; type?: SearchType; limit?: number } = {}) {
    checkYear(opts.year);
    const limit = opts.limit ?? 20;
    const type = opts.type ?? "all";
    // Type filtering is client-side on the real site too, so over-fetch when filtering.
    const { total, results } = await this.client.search(query, opts.year ?? defaultYear(), type === "all" ? limit : 100);
    const filtered = type === "all" ? results : results.filter((h) => hitType(h.contentTypeLabel) === type);
    return {
      query,
      type,
      year: opts.year ?? defaultYear(),
      total: type === "all" ? total : filtered.length,
      results: filtered.slice(0, limit).map(formatHit),
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
    const rules = (subject.enrolment_rules ?? []).map((rule: { type?: string; rule: string }) => {
      const isCo = /co-?requisite/i.test(rule.type ?? "");
      const tree = parseRule(rule.rule);
      const result = evaluateRule(tree, isCo ? withConcurrent.found : done.found);
      return { type: rule.type, rule: rule.rule, met: result.met, missing: missingParts(result), evaluation: result };
    });
    const exclusionText = `${subject.exclusions ?? ""}\n${subject.restrictions ?? ""}`.toUpperCase();
    const excluded = [...new Set([...completed, ...concurrent].map((c) => c.trim().toUpperCase()))]
      .filter((c) => /^[A-Z0-9]+$/.test(c) && new RegExp(`(?<![A-Z0-9])${c}(?![A-Z0-9])`).test(exclusionText));
    const vals = rules.map((x: { met: boolean | null }) => x.met);
    const eligible = excluded.length ? false : vals.includes(false) ? false : vals.includes(null) ? null : true;
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
