import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const COURSE = process.argv[2] ?? "766";
const YEAR = Number(process.argv[3] ?? new Date().getFullYear());
const CONCURRENCY = 4;

async function connect(withElicitation) {
  const client = new Client(
    { name: "crawl", version: "1.0.0" },
    { capabilities: withElicitation ? { elicitation: { form: {} } } : {} },
  );
  const prompts = [];
  if (withElicitation) {
    // Simulated user: always picks the first option offered.
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const choices = req.params.requestedSchema.properties.choice.enum;
      prompts.push({ message: req.params.message, choices });
      return { action: "accept", content: { choice: choices[0] } };
    });
  }
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "ignore" }));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    if (res.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${text}`);
    return JSON.parse(text);
  };
  return { client, call, prompts };
}

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

const { client, call, prompts } = await connect(true);
const plain = await connect(false);
const failures = [];
const warnings = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// 1. Course + every major
const course = await call("get_course", { identifier: COURSE, year: YEAR, expand_majors: true });
const subjects = new Map(); // code -> where it was found
const otherLinks = new Set();
const walk = (g, where) => {
  for (const it of g.items ?? []) {
    if (it.kind === "subject") subjects.set(it.code, [...(subjects.get(it.code) ?? []), where]);
    else if (it.kind !== "major_or_minor") otherLinks.add(`${it.kind} ${it.code} ${it.name}`);
  }
  for (const c of g.groups ?? []) walk(c, `${where} › ${c.title}`);
};
for (const v of course.structure.variants) walk(v, v.title);
for (const [code, m] of Object.entries(course.major_structures ?? {})) {
  check(m.structure, `major ${code} has no structure`);
  if (m.structure) walk(m.structure, `${code} ${m.title}`);
}
console.log(`${course.code} ${course.title} (${YEAR}): ${course.structure.variants.length} structure variants, ${Object.keys(course.major_structures ?? {}).length} majors, ${subjects.size} distinct subjects`);

// 2. Every subject, its assessments, every offering, eligibility
const report = [];
let calls = 0;
await mapLimit([...subjects.keys()].sort(), CONCURRENCY, async (code) => {
  const row = { code, found_in: subjects.get(code) };
  try {
    const s = await call("get_subject", { identifier: code, year: YEAR }); calls++;
    row.title = s.title; row.credit_points = s.credit_points; row.version_year = s.version_year;
    row.offerings = (s.offerings ?? []).map((o) => o.offering);
    row.enrolment_rules = s.enrolment_rules ?? [];
    check(s.code === code, `${code}: get_subject returned ${s.code}`);
    check(s.credit_points > 0, `${code}: missing credit points`);
    check(s.description, `${code}: missing description`);
    if (!row.offerings.length) warnings.push(`${code}: no offerings published for ${YEAR}`);

    row.offering_details = [];
    for (const off of row.offerings) {
      const d = await call("get_subject_offering", { identifier: code, year: YEAR, offering: off }); calls++;
      check(d.offering === off, `${code}: asked for ${off}, got ${d.offering}`);
      check(!d.needs_selection, `${code}: exact offering ${off} still needed selection`);
      const yearSessions = (d.sessions ?? []).filter((x) => Number(x.academic_year) === YEAR);
      if (!yearSessions.length) warnings.push(`${code} ${off}: no ${YEAR} session dates (got ${(d.sessions ?? []).map((x) => x.academic_year).join(",") || "none"})`);

      // Assessments are offering-specific: the full list only exists on the offering's page.
      const a = await call("get_subject_assessments", { identifier: code, year: YEAR, offering: off }); calls++;
      check(a.offering === off, `${code}: assessments for ${off} returned offering ${a.offering}`);
      const detail = { offering: off, sessions: yearSessions, lecturers: (d.lecturers ?? []).length, total_weight: a.total_weight,
        assessments: a.assessments.map((x) => `${x.number}. ${x.name} ${x.weight}% ${x.group_or_individual ?? "?"} ${x.type ?? ""}`) };
      row.offering_details.push(detail);
      if (!a.assessments.length) warnings.push(`${code} ${off}: no assessments published`);
      else {
        // Incomplete handbook data is reported (and must be flagged to the user), not a parser failure.
        if (a.total_weight !== 100) {
          warnings.push(`${code} ${off}: published weights sum to ${a.total_weight}%`);
          check(a.warning, `${code} ${off}: weights sum to ${a.total_weight}% but no warning was returned`);
        }
        for (const x of a.assessments) {
          check(x.name && (x.weight !== undefined || x.weight_note), `${code} ${off}: assessment missing name/weight ${JSON.stringify(x)}`);
          if (!["Individual", "Group"].includes(x.group_or_individual)) warnings.push(`${code} ${off}: "${x.name}" has no Individual/Group value in the handbook`);
        }
      }
    }

    // Selection flow: no filter -> elicitation picks first; without elicitation -> needs_selection.
    if (row.offerings.length > 1) {
      const picked = await call("get_subject_offering", { identifier: code, year: YEAR }); calls++;
      check(picked.offering === row.offerings[0], `${code}: elicitation pick returned ${picked.offering}`);
      const fallback = await plain.call("get_subject_offering", { identifier: code, year: YEAR }); calls++;
      check(fallback.needs_selection && fallback.options.length === row.offerings.length, `${code}: no needs_selection fallback`);
      const pickedA = await call("get_subject_assessments", { identifier: code, year: YEAR }); calls++;
      check(pickedA.offering === row.offerings[0], `${code}: assessments elicitation pick returned ${pickedA.offering}`);
      const fallbackA = await plain.call("get_subject_assessments", { identifier: code, year: YEAR }); calls++;
      check(fallbackA.needs_selection && Array.isArray(fallbackA.common_assessments), `${code}: assessments had no needs_selection fallback`);
    }
    const elig = await call("check_subject_eligibility", { subject: code, completed: [], year: YEAR }); calls++;
    row.eligible_with_nothing = elig.eligible;
    const hasPre = row.enrolment_rules.some((r) => /pre/i.test(r.type));
    check(!hasPre || elig.eligible !== true, `${code}: eligible with no subjects despite prerequisites`);
    for (const r of elig.rules) if (r.met === null) warnings.push(`${code}: rule needs manual check: "${r.rule}"`);
  } catch (err) {
    failures.push(`${code}: ${err.message}`);
  }
  report.push(row);
  process.stdout.write(".");
});
console.log();

// 3. Year handling
for (const y of [2021, YEAR - 1]) {
  const s = await call("get_subject", { identifier: "CSIT110", year: y }); calls++;
  check(s.version_year <= y, `year ${y}: served version ${s.version_year}`);
}
const pre = await client.callTool({ name: "get_subject", arguments: { identifier: "CSIT110", year: 2019 } });
check(pre.isError && /2021/.test(pre.content[0].text), `pre-2021 did not return the server-side limitation message`);
const dflt = await call("get_subject", { identifier: "CSIT110" });
check(dflt.year === new Date().getFullYear(), `default year was ${dflt.year}`);

await client.close();
await plain.client.close();

mkdirSync("test-results", { recursive: true });
report.sort((a, b) => a.code.localeCompare(b.code));
writeFileSync("test-results/crawl-766.json", JSON.stringify({ course: COURSE, year: YEAR, other_links: [...otherLinks], failures, warnings, prompts, subjects: report }, null, 2));

console.log(`\n${report.length} subjects, ${calls} tool calls, ${prompts.length} elicitation prompts`);
if (otherLinks.size) console.log(`Non-subject links (not crawled): ${[...otherLinks].join("; ")}`);
console.log(`\nWarnings (${warnings.length}):\n  ${warnings.join("\n  ")}`);
console.log(`\nFailures (${failures.length}):\n  ${failures.join("\n  ") || "none"}`);
console.log("\nFull report: test-results/crawl-766.json");
process.exit(failures.length ? 1 : 0);
