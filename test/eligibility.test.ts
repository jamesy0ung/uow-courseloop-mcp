import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandbookClient, RateLimitedError, type Fetcher } from "../src/client.js";
import { Handbook, PRE_2021_MESSAGE, UserError } from "../src/handbook.js";
import { courseStructure, parseStructure } from "../src/parse.js";
import { evaluateRule, missingParts, parseRule } from "../src/requisites.js";

const fx = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const pageOf = (file: string) => JSON.parse(fx(file).match(/__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)![1]).props.pageProps.pageContent;

/** Fixtures where saved; any other 2026 subject is synthesised as a 6cp subject. */
const fetcher: Fetcher = async (raw) => {
  const url = new URL(raw);
  const routes: Record<string, string> = {
    "/subjects/2026/CSIT110": "subject-CSIT110-2026.html",
    "/subjects/2026/CSIT226": "subject-CSIT226-2026.html",
    "/subjects/2026/CSCI251": "subject-CSCI251-2026.html",
    "/courses/2026/766": "course-766-2026.html",
    "/aos/2026/MAJ40516": "aos-MAJ40516-2026.html",
  };
  if (routes[url.pathname]) return { status: 200, body: fx(routes[url.pathname]) };
  const m = url.pathname.match(/^\/subjects\/2026\/([A-Z]{4}\d{3})$/);
  if (m && m[1] !== "ZZZZ999") {
    const data = { props: { pageProps: { pageContent: { code: m[1], title: `Synthetic ${m[1]}`, credit_points: m[1] === "CSIT321" ? "12" : "6" } } } };
    return { status: 200, body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>` };
  }
  return { status: 404, body: "" };
};
const hb = () => new Handbook(new HandbookClient({ fetcher }));

afterEach(() => vi.useRealTimers());

describe("requisite parser", () => {
  const done = (...codes: string[]) => codes.map((code) => ({ code, credit_points: 6 }));
  const met = (rule: string, ...codes: string[]) => evaluateRule(parseRule(rule), done(...codes)).met;

  it("handles and/or/brackets with UOW's spellings", () => {
    expect(met("(CSIT110 or CSIT111) AND (CSIT113 or CSIT123)", "CSIT111", "CSIT123")).toBe(true);
    expect(met("(CSIT110 or CSIT111) AND (CSIT113 or CSIT123)", "CSIT111")).toBe(false);
    expect(met("CSIT110 OR CSIT111 OR ENGG100", "ENGG100")).toBe(true);
    expect(met("(CSIT121 and CSIT214) OR (ECTE250 and CSCI291)", "ECTE250", "CSCI291")).toBe(true);
    expect(met("CSIT127, CSIT121, and 12cp 200 level CSCI/CSIT", "CSIT127", "CSIT121", "CSCI235", "CSIT214")).toBe(true);
    expect(met("CSIT121 + 12cp 200 level CSCI", "CSIT121", "CSCI235", "CSIT214")).toBe(false); // CSIT214 isn't CSCI
  });

  it("evaluates credit-point clauses by level, prefix and 'another'", () => {
    // "another 18cp at 100 level" must not count the CSIT110 that satisfied the first part.
    expect(met("(CSIT110 or CSIT111) and another 18cp at 100 level", "CSIT110", "CSIT114", "CSIT115")).toBe(false);
    expect(met("(CSIT110 or CSIT111) and another 18cp at 100 level", "CSIT110", "CSIT114", "CSIT115", "CSIT127")).toBe(true);
    // No "another": CSIT127 itself counts towards the 12cp of 100-level CSIT.
    expect(met("CSIT127 and 12cp at 100-level of CSIT", "CSIT127", "CSIT110")).toBe(true);
    expect(met("CSIT127 and 12cp at 100-level of CSIT", "CSIT127", "MATH141")).toBe(false);
  });

  it("returns null for rules it cannot read and explains what is missing", () => {
    expect(met("Permission of the Head of School")).toBeNull();
    const ev = evaluateRule(parseRule("CSIT214 and 12 credit points at 200 level CSCI/ISIT"), done("CSCI235"));
    expect(missingParts(ev)).toEqual(["CSIT214", "12 credit points at 200 level CSCI/ISIT (have 6cp of 12cp)"]);
  });

  it.each([
    "6cp with a distinction average",
    "6cp with permission of the Head of School",
    "6cp in approved electives",
    "6cp at 200 level or above",
    "6cp or permission of the Head of School",
    "CSIT214 or",
    "(CSIT214",
    "CSIT214 and or CSIT110",
  ])("requires manual checking for unsupported or incomplete wording: %s", (rule) => {
    const result = evaluateRule(parseRule(rule), done("CSIT214", "CSIT110"));
    expect(result.met).toBeNull();
    expect(missingParts(result)).toEqual([`verify manually: "${rule}"`]);
  });
});

describe("course structure variants (766)", () => {
  const s = courseStructure(parseStructure(pageOf("course-766-2026.html").curriculumStructure))!;

  it("splits campus variants, keeps Honours as a pathway, attaches KDU's groups", () => {
    expect(s.variants.map((v) => v.title)).toContain("Bachelor of Computer Science at Wollongong Campus");
    expect(s.variants.find((v) => v.title.includes("Honours"))?.category).toBe("Course");
    const kdu = s.variants.find((v) => v.title.includes("KDU"))!;
    expect(kdu.groups?.map((g) => g.title).sort()).toEqual(["Core", "Electives"]);
    expect(kdu.note).toMatch(/attached/);
    expect(s.common_groups).toBeUndefined();
  });
});

describe("check_subject_eligibility", () => {
  it("does not approve a prerequisite with an unsupported grade condition", async () => {
    const handbook = new Handbook(new HandbookClient({ fetcher: async () => ({
      status: 200,
      body: `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { pageContent: {
        code: "CSCI251", title: "Example subject", credit_points: "6",
        enrolment_rules_applied_to_all: [{ type_label: "Pre-Requisite", description: "6cp with a distinction average" }],
      } } } })}</script>`,
    }) }));
    const result = await handbook.checkSubjectEligibility("CSCI251", ["CSIT214"], [], 2026);
    expect(result.eligible).toBeNull();
    expect(result.summary).toContain("could not be checked automatically");
    expect(result.rules[0].missing).toEqual(['verify manually: "6cp with a distinction average"']);
  });

  it("evaluates CSCI251's prerequisite", async () => {
    expect((await hb().checkSubjectEligibility("CSCI251", ["CSIT213"], [], 2026)).eligible).toBe(true);
    const no: any = await hb().checkSubjectEligibility("CSCI251", ["CSIT110"], [], 2026);
    expect(no.eligible).toBe(false);
    expect(no.summary).toMatch(/one of: CSIT121 \| CSIT213/);
  });
});

describe("offering selection", () => {
  it("returns options when the client can't ask the user", async () => {
    const r: any = await hb().getSubjectOffering("CSIT110", {}, 2026);
    expect(r.needs_selection).toBe(true);
    expect(r.options).toHaveLength(8);
    expect(r.options[0]).toEqual({ value: "Wollongong-Autumn-On-Campus", label: "Wollongong · Autumn · On-Campus" });
  });

  it("uses the user's choice when the client can ask", async () => {
    const chooser = vi.fn(async () => "Wollongong-Spring-On-Campus");
    const r: any = await hb().getSubjectAssessments("CSIT110", { campus: "Wollongong" }, 2026, chooser);
    expect(chooser).toHaveBeenCalledOnce();
    expect(r.offering).toBe("Wollongong-Spring-On-Campus");
  });

  it("falls back to options if the user declines", async () => {
    const r: any = await hb().getSubjectOffering("CSIT110", { campus: "Wollongong" }, 2026, async () => undefined);
    expect(r.options.map((o: any) => o.value)).toEqual(["Wollongong-Autumn-On-Campus", "Wollongong-Spring-On-Campus"]);
  });
});

describe("years", () => {
  it("defaults to the current year from the system clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    const s: any = await hb().getSubject("CSIT110");
    expect(s.year).toBe(2026);
  });

  it("explains that pre-2021 is a server-side limitation", async () => {
    await expect(hb().getSubject("CSIT110", 2019)).rejects.toThrow(PRE_2021_MESSAGE);
    await expect(hb().search("CSIT110", { year: 2020 })).rejects.toBeInstanceOf(UserError);
  });
});

describe("rate limiting", () => {
  it("turns CloudFront 403s into a clear, uncached error", async () => {
    let calls = 0;
    const client = new HandbookClient({ fetcher: async () => (++calls === 1 ? { status: 403, body: "" } : { status: 200, body: fx("subject-CSIT110-2026.html") }) });
    await expect(client.getPage("subjects", 2026, "CSIT110")).rejects.toBeInstanceOf(RateLimitedError);
    await expect(client.getPage("subjects", 2026, "CSIT110")).resolves.toMatchObject({ content: { code: "CSIT110" } });
  });
});
