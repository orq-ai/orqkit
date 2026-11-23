import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { csrfToken } from "../../../src/lib/dashboard/security.js";
import { simulationReportTabs } from "../../../src/lib/dashboard/simulation-report-tabs.js";
import { exportSimulationHtml } from "../../../src/lib/integrations/simulation/reports/export-html.js";
import { SimulationRun } from "../../../src/lib/integrations/simulation/run-store.js";
import goldens from "../fixtures/simulation-html-python-goldens.json" with {
  type: "json",
};

const hash = (html: string) =>
  createHash("sha256")
    .update(html.replaceAll(csrfToken(), "CSRF"))
    .digest("hex");
let original: NodeJS.ProcessEnv, directory: string;
beforeEach(async () => {
  original = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "eq-simulation-html-"));
  for (const key of [
    "ORQ_WORKSPACE",
    "ORQ_WORKSPACE_SLUG",
    "ORQ_API_KEY",
    "ORQ_UI_BASE_URL",
  ])
    delete process.env[key];
  process.env.ORQ_BASE_URL = "https://fallback.example";
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
for (const [index, row] of goldens.cases.entries())
  test(`Python complete simulation report ${index}`, async () => {
    const run = new SimulationRun(goldens.runs[row.run]?.input),
      results =
        row.indexes === null
          ? undefined
          : row.indexes
              .map((i) => run.results[i])
              .filter((r) => r !== undefined);
    expect(
      hash(
        await simulationReportTabs('r<&"', run, {
          results,
          compareHtml: "<span>Compare</span>",
          standalone: row.standalone,
        }),
      ),
    ).toBe(row.body);
    if (row.document !== null)
      expect(hash(await exportSimulationHtml(run))).toBe(row.document);
  });
for (const [index, row] of goldens.lists.entries())
  test(`Python result-list simulation export ${index}`, async () => {
    const run = new SimulationRun(goldens.runs[row.run]?.input);
    expect(
      hash(
        await exportSimulationHtml(run.results, {
          target: "target <label>",
          runDate: run.createdAt,
          executiveSummary: run.executiveSummary,
          experimentUrl: run.experimentUrl,
          recommendations: run.recommendations,
          runTokenUsageTotal: run.tokenUsageTotal,
        }),
      ),
    ).toBe(row.expected);
  });
test("standalone simulation embeds every conversation and full config without interactive loaders", async () => {
  const row = goldens.runs.find((r) => r.input.results.length > 1);
  if (!row) throw Error("missing run");
  const run = new SimulationRun(row.input),
    html = await exportSimulationHtml(run);
  expect(html).toStartWith("<!DOCTYPE html>");
  expect(
    html.match(/class="rk-panel export-conversation export-evidence"/g)?.length,
  ).toBe(run.results.length);
  expect(html).not.toContain("hx-get=");
  expect(html).not.toContain("hx-post=");
  expect(html).not.toContain("<script");
  expect(html).toContain("base64,");
  expect(html).toContain('id="conv-1"');
  expect(html).toContain('id="simtab-config"');
});
