# uow-courseloop-mcp

MCP server for the University of Wollongong handbook (https://courses.uow.edu.au, CourseLoop).
Look up courses, subjects and majors/minors by code or name, switch years, select a subject
offering (session × campus × delivery) and read full assessment details.

Eventually the goal is so I can ask my agent something like "find me some nice easy business subjects next Spring so I can graduate with no group projects or/and no final exam"

## Tools
| Tool | Example |
|---|---|
| `search_handbook` | `{query: "Bachelor of Computer Science", type: "course"}` |
| `get_course` | `{identifier: "766"}` |
| `get_area_of_study` | `{identifier: "Cyber Security"}` |
| `get_subject` | `{identifier: "CSIT110", year: 2025}` |
| `get_subject_offering` | `{identifier: "CSIT110", session: "Autumn", campus: "Wollongong"}` |
| `get_subject_assessments` | `{identifier: "CSCI316", campus: "Wollongong"}` (or `all_offerings: true`) |
| `check_subject_eligibility` | `{subject: "CSIT321", completed: ["CSIT214", "CSCI235", "CSCI251", "CSIT226"], concurrent: ["CSIT314"]}` |

- `year` defaults to the current year from the system clock. Years before 2021 are not available (server-side limitation of courses.uow.edu.au).
- When a request matches several offerings, the user gets a pick-list (MCP elicitation). Clients without elicitation get `needs_selection: true` plus the options instead.
- Assessments differ between offerings, so `get_subject_assessments` always works on a single selected offering.
- Requests are throttled to about 80/min, because otherwise this triggers CloudFront's rate limit.

## Setup
```sh
npm install
npm run build
claude mcp add uow-courseloop -- node "$(pwd)/dist/index.js"
```
Claude Desktop (`claude_desktop_config.json`):
```json
{ "mcpServers": { "uow-courseloop": { "command": "node", "args": ["/absolute/path/to/dist/index.js"] } } }
```

## Testing
- `npm test` runs offline unit tests against saved fixtures in `test/fixtures/`
- `npm run smoke` builds the server, then calls every tool live over stdio
- `npm run crawl` exercises every subject, major and offering reachable from course 766 through the MCP server (takes about 3.5 minutes, throttled)

## Course planning
Use `get_course` to read the campus structure, then `get_area_of_study` for each intended major. The assistant can compare these published requirements with completed subjects, cite sources, and identify uncertainty. There is no automated graduation verdict; confirm graduation eligibility with UOW.

Eligibility checks return `eligible: null` when rule text cannot be fully interpreted. Offering dates are restricted to the requested year; missing dates are reported explicitly.