import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderAgentHeatmap,
  renderBreakdown,
} from "../../../src/lib/dashboard/redteam-charts.js";
import {
  renderAgentSide,
  renderAttackFragment,
  renderDisagreement,
} from "../../../src/lib/dashboard/redteam-transcripts.js";
import {
  RedTeamReport,
  RedTeamResult,
} from "../../../src/lib/redteam/reports/models.js";
import goldens from "../fixtures/dashboard-views-python-goldens.json" with {
  type: "json",
};

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  return value;
}
const hash = (html: string) =>
  createHash("sha256")
    .update(
      html.replace(
        /(<script type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/g,
        (_, open, json, close) =>
          open +
          JSON.stringify(normalize(JSON.parse(json))).replaceAll("</", "<\\/") +
          close,
      ),
    )
    .digest("hex");
for (const row of goldens.charts)
  test(`Python chart ${row.label}`, () => {
    const report = new RedTeamReport(goldens.reports[row.reportIndex]);
    const options = row.options;
    const html =
      "dim" in options
        ? renderAgentHeatmap({
            report,
            dim: options.dim as string,
            rid: options.rid,
            containerId: options.container_id,
          })
        : renderBreakdown({
            report,
            groupBy: options.group_by as string,
            stackBy: options.stack_by ?? null,
            rid: options.rid,
            containerId: options.container_id,
          });
    expect(hash(html)).toBe(row.expectedSha256);
  });
for (const row of goldens.disagreements)
  test(`Python disagreement ${row.label}`, () => {
    const report = new RedTeamReport(goldens.reports[row.reportIndex]),
      options = row.options;
    expect(
      hash(
        renderDisagreement({
          report,
          agentA: options.agent_a,
          agentB: options.agent_b,
          page: options.page,
          rid: options.rid,
          containerId: options.container_id,
        }),
      ),
    ).toBe(row.expectedSha256);
  });
let original: NodeJS.ProcessEnv, directory: string;
beforeEach(async () => {
  original = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "eq-attack-fragment-"));
  for (const key of [
    "ORQ_WORKSPACE",
    "ORQ_WORKSPACE_SLUG",
    "ORQ_API_KEY",
    "ORQ_UI_BASE_URL",
  ])
    delete process.env[key];
  process.env.PATH = directory;
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(directory, "settings.json");
  await writeFile(process.env.EVALUATORQ_DASHBOARD_SETTINGS, "{}");
});
afterEach(async () => {
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(original, key)) delete process.env[key];
  Object.assign(process.env, original);
  await rm(directory, { recursive: true, force: true });
});
for (const row of goldens.fragments)
  test(`Python attack fragment ${row.label}`, async () => {
    expect(hash(await renderAttackFragment(new RedTeamResult(row.input)))).toBe(
      row.expectedSha256,
    );
  });
test("attack trace button prefers last successful response trace, with thread fallback", async () => {
  const raw = goldens.fragments[0]?.input;
  process.env.ORQ_WORKSPACE = "workspace";
  process.env.ORQ_BASE_URL = "https://ui.example";
  const result = new RedTeamResult({
    ...raw,
    threadId: "run:agent:1",
    responseTraces: [
      { traceId: "first", spanId: "s1" },
      { traceId: "latest", spanId: "s2" },
      { traceId: null, spanId: null },
    ],
  });
  const html = await renderAttackFragment(result);
  expect(html).toContain("/workspace/traces/(trace:latest)");
  expect(html).toContain(">View Trace</a>");
  result.responseTraces = [];
  expect(await renderAttackFragment(result)).toContain(
    "thread_id%3Ais%3Arun%3Aagent%3A1",
  );
});
test("comparison view extracts multimodal text without exposing opaque content objects", () => {
  const result = new RedTeamResult({
    ...goldens.fragments[0]?.input,
    messages: [
      {
        role: "user",
        content: [{ type: "input_text", text: "<external instruction>" }],
      },
    ],
  });
  expect(renderAgentSide(result, "Agent")).toContain(
    "&lt;external instruction&gt;",
  );
  expect(renderAgentSide(result, "Agent")).not.toContain("[object Object]");
});
