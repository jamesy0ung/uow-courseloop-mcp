import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandbookClient, type Fetcher } from "../src/client.js";
import { Handbook, looksLikeCode, UserError } from "../src/handbook.js";
import { htmlToText, matchOfferings, parseOfferings, parseOfferingDetail } from "../src/parse.js";

const fx = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

/** Serves saved fixtures in place of courses.uow.edu.au. */
const fixtureFetcher: Fetcher = async (raw) => {
  const url = new URL(raw);
  const offering = url.searchParams.get("offering");
  const routes: Record<string, string> = {
    "/subjects/2026/CSIT110": "subject-CSIT110-2026.html",
    "/subjects/2026/CSIT226": offering === "Dubai-DXB UG Winter-On-Campus" ? "subject-CSIT226-2026-dubai.html" : "subject-CSIT226-2026.html",
    "/subjects/2026/CSCI251": "subject-CSCI251-2026.html",
    "/subjects/2026/CSCI316": offering === "Wollongong-Autumn-On-Campus" ? "subject-CSCI316-2026-wollongong-autumn.html" : "subject-CSCI316-2026.html",
    "/courses/2026/766": "course-766-2026.html",
    "/aos/2026/MAJ40516": "aos-MAJ40516-2026.html",
  };
  if (url.pathname === "/api/search/search-all") {
    const q = url.searchParams.get("query")!.toLowerCase();
    return { status: 200, body: fx(q.includes("bachelor") ? "search-bcs.json" : "search-computer.json") };
  }
  const file = routes[url.pathname];
  return file ? { status: 200, body: fx(file) } : { status: 404, body: "not found" };
};

const hb = () => new Handbook(new HandbookClient({ fetcher: fixtureFetcher }));

describe("helpers", () => {
  it("detects codes vs names", () => {
    for (const c of ["766", "CSIT110", "MAJ40516", "csit226", "3165"]) expect(looksLikeCode(c)).toBe(true);
    for (const n of ["Bachelor of Computer Science", "cyber security", "CSIT 110"]) expect(looksLikeCode(n)).toBe(false);
  });

  it("converts html to text", () => {
    expect(htmlToText("<p>A &amp; B</p><ul><li>one</li><li>two</li></ul>")).toBe("A & B\n\n• one\n• two");
  });
});

describe("search", () => {
  it("returns typed, normalised hits", async () => {
    const r = await hb().search("Bachelor of Computer Science", { year: 2026 });
    expect(r.results[0]).toMatchObject({ code: "766", title: "Bachelor of Computer Science", type: "course", year: 2026 });
    expect(r.results[0].url).toBe("https://courses.uow.edu.au/courses/2026/766");
  });

  it("filters by type client-side", async () => {
    const r = await hb().search("computer", { type: "minor", year: 2026 });
    expect(r.results.length).toBe(2);
    expect(r.results.every((h) => h.type === "minor")).toBe(true);
  });
});

describe("get_course", () => {
  it("resolves by name and returns the structure tree", async () => {
    const c: any = await hb().getCourse("Bachelor of Computer Science", 2026);
    expect(c).toMatchObject({ code: "766", credit_points: 144, full_time_duration: "3 Year(s)", resolved_from: "Bachelor of Computer Science" });
    expect(c.available_years).toContain(2021);
    expect(c.campuses.map((x: any) => x.campus)).toContain("Wollongong");
    const json = JSON.stringify(c.structure);
    expect(json).toContain('"code":"CSIT110"');
    expect(json).toContain('"kind":"major_or_minor"');
  });

  it("can skip the structure", async () => {
    const c: any = await hb().getCourse("766", 2026, { includeStructure: false });
    expect(c.structure).toBeUndefined();
  });
});

describe("get_area_of_study", () => {
  it("parses a major", async () => {
    const a: any = await hb().getAreaOfStudy("MAJ40516", 2026);
    expect(a).toMatchObject({ code: "MAJ40516", title: "Cyber Security", type: "major", credit_points: 24 });
    expect(a.structure).toBeDefined();
  });
});

describe("get_subject", () => {
  it("parses CSIT110 with offerings and assessment summary", async () => {
    const s: any = await hb().getSubject("CSIT110", 2026);
    expect(s).toMatchObject({ code: "CSIT110", credit_points: 6, level: "100", version_year: 2026 });
    expect(s.offerings).toHaveLength(8);
    expect(s.offerings[0]).toMatchObject({ offering: "Wollongong-Autumn-On-Campus", campus: "Wollongong", session: "Autumn", delivery: "On-Campus" });
    expect(s.assessments_common_to_all_offerings).toEqual(["Programming Assignments (50%, Individual)", "Final exam (50%, Individual)"]);
  });

  it("includes prerequisites from enrolment rules", async () => {
    const s: any = await hb().getSubject("CSCI251", 2026);
    expect(s.enrolment_rules).toContainEqual({ type: "Pre-Requisite", rule: "CSIT121 or CSIT213" });
  });

  it("reports unknown subjects clearly", async () => {
    await expect(hb().getSubject("ZZZZ999", 2026)).rejects.toBeInstanceOf(UserError);
  });
});

describe("offerings", () => {
  it("does not substitute dates from another year", () => {
    const result = parseOfferingDetail({ teaching_period_instances: [
      { academic_year: "2025", learning_start_date: "2025-03-01" },
      { academic_year: "2027", learning_start_date: "2027-03-01", census_date: "2027-03-31" },
    ] }, 2026);
    expect(result.sessions).toBeUndefined();
    expect(result.sessions_note).toBe("Session dates are not published for 2026.");
  });

  it("explains when no session dates are published", () => {
    expect(parseOfferingDetail({}, 2026).sessions_note).toBe("Session dates are not published for 2026.");
  });

  it("matches by session + campus, case-insensitively", () => {
    const pc = (JSON.parse(fx("subject-CSIT110-2026.html").match(/__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)![1]) as any).props.pageProps.pageContent;
    const offs = parseOfferings(pc);
    expect(matchOfferings(offs, { session: "autumn", campus: "wollongong" }).map((o) => o.offering)).toEqual(["Wollongong-Autumn-On-Campus"]);
    expect(matchOfferings(offs, { campus: "Wollongong" })).toHaveLength(2);
    expect(matchOfferings(offs, { offering: "liverpool-spring-on-campus" })).toHaveLength(1);
  });

  it("returns options when ambiguous", async () => {
    const r: any = await hb().getSubjectOffering("CSIT226", { campus: "Singapore" }, 2026);
    expect(r.needs_selection).toBe(true);
    expect(r.options.length).toBe(2);
  });

  it("fetches offering-specific detail", async () => {
    const r: any = await hb().getSubjectOffering("CSIT226", { campus: "dubai" }, 2026);
    expect(r).toMatchObject({ offering: "Dubai-DXB UG Winter-On-Campus", campus: "Dubai", session: "DXB UG Winter", quota: 470 });
    // Only the requested year's session dates are returned, not every future year.
    expect(r.sessions).toEqual([expect.objectContaining({ academic_year: "2026", start_date: "2026-01-05", census_date: "2026-01-21" })]);
    expect(r.lecturers.length).toBeGreaterThan(0);
  });

  it("errors with the valid list when nothing matches", async () => {
    await expect(hb().getSubjectOffering("CSIT226", { campus: "Mars" }, 2026)).rejects.toThrow(/Available: .*Wollongong-Spring-On-Campus/);
  });
});

describe("get_subject_assessments", () => {
  it("returns all expanded assessments for CSIT226", async () => {
    const r: any = await hb().getSubjectAssessments("CSIT226", { campus: "dubai" }, 2026);
    expect(r.offering).toBe("Dubai-DXB UG Winter-On-Campus");
    expect(r.total_weight).toBe(100);
    expect(r.assessments.map((a: any) => [a.number, a.name, a.weight, a.group_or_individual, a.type])).toEqual([
      [1, "Individual quizzes", 20, "Individual", "Quiz"],
      [2, "Project Part A", 15, "Group", "Project"],
      [3, "Project Part B", 15, "Group", "Project"],
      [4, "Project Part C", 10, "Group", "Presentation"],
      [5, "Final Exam", 40, "Individual", "Exam"],
    ]);
    expect(r.assessments[0].applies_to).toBe("all offerings");
  });

  it("validates an offering filter", async () => {
    const r: any = await hb().getSubjectAssessments("CSIT110", { session: "Spring", campus: "Liverpool" }, 2026);
    expect(r.offering).toBe("Liverpool-Spring-On-Campus");
    expect(r.assessments).toHaveLength(2);
  });

  it("fetches offering-specific assessments (CSCI316 differs by offering)", async () => {
    const r: any = await hb().getSubjectAssessments("CSCI316", { campus: "Wollongong", session: "Autumn" }, 2026);
    expect(r.offering).toBe("Wollongong-Autumn-On-Campus");
    expect(r.total_weight).toBe(100);
    expect(r.assessments.map((a: any) => [a.name, a.weight, a.group_or_individual])).toEqual([
      ["Quiz", 15, "Individual"],
      ["Assignment", 15, "Individual"],
      ["Group Project", 25, "Group"],
      ["Final Exam", 45, "Individual"],
    ]);
    expect(r.assessments[1].applies_to).toBe("all offerings");
    expect(r.assessments[0].applies_to).toContain("Wollongong-Autumn-On-Campus");
  });

  it("asks for an offering and shows the common assessments meanwhile", async () => {
    const r: any = await hb().getSubjectAssessments("CSCI316", {}, 2026);
    expect(r.needs_selection).toBe(true);
    expect(r.options).toHaveLength(5); // Liverpool-Autumn-Flexible is published but offered=false
    expect(r.common_assessments.map((a: any) => a.name)).toEqual(["Assignment"]);
  });

  it("can return every offering's assessments", async () => {
    const r: any = await hb().getSubjectAssessments("CSCI316", {}, 2026, undefined, true);
    expect(r.by_offering).toHaveLength(5);
    expect(r.by_offering.find((o: any) => o.offering === "Wollongong-Autumn-On-Campus").assessments).toHaveLength(4);
    expect(r.by_offering.find((o: any) => o.offering === "Dubai-DXB UG Winter-On-Campus").assessments).toHaveLength(1);
  });
});

describe("incomplete handbook data", () => {
  it("warns when an offering's published weights don't sum to 100", async () => {
    const r: any = await hb().getSubjectAssessments("CSCI316", { campus: "Dubai" }, 2026);
    expect(r.total_weight).toBe(15);
    expect(r.warning).toMatch(/sum to 15%, not 100%/);
  });
});
