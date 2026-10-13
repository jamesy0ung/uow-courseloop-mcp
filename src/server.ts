import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FIRST_YEAR, Handbook, UserError, type Chooser } from "./handbook.js";
import { NotFoundError, RateLimitedError } from "./client.js";

const YEAR_NOTE =
  `Only ${FIRST_YEAR} onwards works: earlier handbook years are not served by courses.uow.edu.au (server-side limitation).`;

const year = z
  .number()
  .int()
  .optional()
  .describe(`Handbook year. Defaults to the current calendar year from the system clock. ${YEAR_NOTE}`);

const identifier = (eg: string) => z.string().min(1).describe(`Code or name, e.g. ${eg}`);
const codes = (what: string) =>
  z.array(z.string().min(1)).describe(`${what} as subject codes, e.g. ["CSIT110", "CSIT115"]`);

const offeringFilter = {
  session: z.string().optional().describe('Session / teaching period, e.g. "Autumn", "Spring", "DXB UG Winter"'),
  campus: z.string().optional().describe('Campus / location, e.g. "Wollongong", "Liverpool", "Dubai"'),
  delivery: z.string().optional().describe('Delivery mode, e.g. "On-Campus", "Online"'),
  offering: z.string().optional().describe('Exact offering name, e.g. "Wollongong-Autumn-On-Campus"'),
};

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown) {
  const message =
    err instanceof UserError || err instanceof NotFoundError || err instanceof RateLimitedError
      ? err.message
      : `Handbook request failed: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export function createServer(handbook = new Handbook()): McpServer {
  const server = new McpServer({ name: "uow-courseloop", version: "1.1.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  /**
   * Ask the user to pick from a list via MCP elicitation when the client supports it.
   * Returns undefined when unsupported/declined, so tools fall back to returning the options.
   */
  const chooser = (requestId: string | number): Chooser | undefined => {
    const caps = server.server.getClientCapabilities()?.elicitation;
    if (!caps) return undefined;
    return async (message, options) => {
      const params = {
        message,
        requestedSchema: {
          type: "object" as const,
          properties: {
            choice: {
              type: "string" as const,
              title: "Option",
              enum: options.map((o) => o.value),
              enumNames: options.map((o) => o.label),
            },
          },
          required: ["choice"],
        },
      };
      try {
        // Clients that advertise `elicitation: {}` (pre form/url split) still support forms.
        const res = caps.form
          ? await server.server.elicitInput({ mode: "form", ...params }, { relatedRequestId: requestId })
          : await server.server.request({ method: "elicitation/create", params }, ElicitResultSchema, { relatedRequestId: requestId });
        return res.action === "accept" ? (res.content?.choice as string | undefined) : undefined;
      } catch {
        return undefined;
      }
    };
  };

  server.registerTool(
    "search_handbook",
    {
      title: "Search UOW handbook",
      description:
        `Search the University of Wollongong course handbook (courses.uow.edu.au) for courses, subjects, majors and minors by name or code (e.g. "766", "Bachelor of Computer Science", "CSIT110", "cyber security"). ${YEAR_NOTE}`,
      inputSchema: {
        query: z.string().min(1).describe("Name, code or keywords"),
        type: z.enum(["all", "course", "subject", "major", "minor"]).optional().describe("Filter by item type (default all)"),
        year,
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
      annotations: readOnly,
    },
    ({ query, type, year, limit }) => run(() => handbook.search(query, { type, year, limit })),
  );

  server.registerTool(
    "get_course",
    {
      title: "Get course",
      description:
        "Get a UOW course (degree) by code or name: overview, credit points, duration, campuses, learning outcomes, the course rules text (e.g. credit-point and 100-level limits) and the structure. " +
        "structure.variants are alternative structures (usually one per campus; a student completes exactly one), each a tree of groups (Core, Major Studies, Electives, Capstone) with subject/major codes and required credit points. " +
        `Set expand_majors to inline every major's subject list. For course planning, use the published campus structure and get_area_of_study for each intended major. Explain outstanding requirements with source links and uncertainty; graduation eligibility requires confirmation by UOW. ${YEAR_NOTE}`,
      inputSchema: {
        identifier: identifier('"766" or "Bachelor of Computer Science"'),
        year,
        include_structure: z.boolean().optional().describe("Include the course structure (default true)"),
        expand_majors: z.boolean().optional().describe("Also fetch and include each major's structure (default false)"),
      },
      annotations: readOnly,
    },
    ({ identifier, year, include_structure, expand_majors }) =>
      run(() => handbook.getCourse(identifier, year, { includeStructure: include_structure, expandMajors: expand_majors })),
  );

  server.registerTool(
    "get_area_of_study",
    {
      title: "Get major / minor",
      description:
        `Get a UOW major, specialisation or minor by code or name (e.g. "MAJ40516", "Cyber Security"): overview, credit points, rules, learning outcomes and its structure of subjects. ${YEAR_NOTE}`,
      inputSchema: { identifier: identifier('"MAJ40516" or "Cyber Security"'), year },
      annotations: readOnly,
    },
    ({ identifier, year }) => run(() => handbook.getAreaOfStudy(identifier, year)),
  );

  server.registerTool(
    "get_subject",
    {
      title: "Get subject",
      description:
        `Get a UOW subject by code or name (e.g. "CSIT110"): description, credit points, level, faculty/school, prerequisites/co-requisites (enrolment_rules), exclusions, equivalents, learning outcomes, every offering (campus × session × delivery) and the assessments common to all offerings (use get_subject_assessments for an offering's full list). Use available_years to change year. ${YEAR_NOTE}`,
      inputSchema: { identifier: identifier('"CSIT110" or "Fundamental Programming with Python"'), year },
      annotations: readOnly,
    },
    ({ identifier, year }) => run(() => handbook.getSubject(identifier, year)),
  );

  server.registerTool(
    "get_subject_offering",
    {
      title: "Get subject offering",
      description:
        "Select one offering of a subject (like the site's availability picker) and return offering-specific details for the year: session start/end and census dates, campus, delivery, contact hours, lecturers/tutors, quota, offering-specific enrolment rules. " +
        "Filters are optional, case-insensitive substrings. If more than one offering matches, the user is asked to pick one (when the client supports it); otherwise the result has needs_selection=true with the options — show them to the user, then call again with offering set to their choice. " +
        `Session dates are for the requested year (default: current year). ${YEAR_NOTE}`,
      inputSchema: { identifier: identifier('"CSIT110"'), year, ...offeringFilter },
      annotations: readOnly,
    },
    ({ identifier, year, ...filter }, extra) =>
      run(() => handbook.getSubjectOffering(identifier, filter, year, chooser(extra.requestId))),
  );

  server.registerTool(
    "get_subject_assessments",
    {
      title: "Get subject assessments",
      description:
        "Get the full assessment details for one offering of a subject (everything behind the site's 'Expand all'): number, name, weight %, Individual or Group, assessment type, learning outcomes, and whether it is common to all offerings or offering-specific. " +
        "Assessments differ between offerings (e.g. CSCI316 Wollongong has 4, Dubai 1), so an offering must be selected: narrow with session/campus/delivery/offering; if several remain the user is asked to pick (when the client supports it), otherwise needs_selection=true is returned with the options — show them to the user and call again with offering set to their choice. " +
        `Set all_offerings=true to get every offering's assessments at once (for comparisons). ${YEAR_NOTE}`,
      inputSchema: {
        identifier: identifier('"CSIT110"'),
        year,
        ...offeringFilter,
        all_offerings: z.boolean().optional().describe("Return assessments for every (matching) offering instead of selecting one"),
      },
      annotations: readOnly,
    },
    ({ identifier, year, all_offerings, ...filter }, extra) =>
      run(() => handbook.getSubjectAssessments(identifier, filter, year, chooser(extra.requestId), all_offerings ?? false)),
  );

  server.registerTool(
    "check_subject_eligibility",
    {
      title: "Check subject eligibility",
      description:
        "Check whether a student can enrol in a subject given the subjects they have completed (and optionally are taking concurrently, for co-requisites). " +
        "Parses the handbook's prerequisite/co-requisite text (subject codes, and/or, brackets, credit-point clauses like '18cp at 200 level CSCI/CSIT') and evaluates it; eligible is true, false, or null when a rule needs manual checking. " +
        YEAR_NOTE,
      inputSchema: {
        subject: identifier('"CSCI251"'),
        completed: codes("Subjects already passed"),
        concurrent: codes("Subjects being taken in the same session").optional(),
        year,
      },
      annotations: readOnly,
    },
    ({ subject, completed, concurrent, year }) =>
      run(() => handbook.checkSubjectEligibility(subject, completed, concurrent ?? [], year)),
  );

  return server;
}
