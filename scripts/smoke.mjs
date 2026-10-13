import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls = [
  ["search_handbook", { query: "766" }],
  ["search_handbook", { query: "Bachelor of Computer Science", type: "course", limit: 3 }],
  ["get_course", { identifier: "Bachelor of Computer Science", include_structure: false }],
  ["get_course", { identifier: "766", year: 2026 }],
  ["get_area_of_study", { identifier: "Cyber Security" }],
  ["get_subject", { identifier: "CSIT110", year: 2026 }],
  ["get_subject", { identifier: "CSIT110", year: 2023 }],
  ["check_subject_eligibility", { subject: "CSCI251", completed: ["CSIT121"], year: 2026 }],
  ["get_subject_offering", { identifier: "CSIT110", year: 2026, session: "autumn", campus: "wollongong" }],
  ["get_subject_offering", { identifier: "CSIT110", year: 2026, campus: "Singapore" }],
  ["get_subject_assessments", { identifier: "CSIT226", year: 2026 }],
  ["get_subject_assessments", { identifier: "CSIT110", year: 2026, session: "Spring", campus: "Liverpool" }],
  ["get_subject", { identifier: "CSIT110", year: 2019 }],
];

let failures = 0;
for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  const expectError = args.year === 2019;
  const okay = Boolean(res.isError) === expectError;
  if (!okay) failures++;
  console.log(`\n${okay ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args)}${res.isError ? " (error)" : ""}`);
  console.log(text.length > 900 ? `${text.slice(0, 900)}\n… (${text.length} chars)` : text);
}

await client.close();
console.log(`\n${calls.length - failures}/${calls.length} smoke calls behaved as expected`);
process.exit(failures ? 1 : 0);
