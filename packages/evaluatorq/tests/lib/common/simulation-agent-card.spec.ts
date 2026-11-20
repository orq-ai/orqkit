import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentDescriptionPreview,
  simulationAgentCard,
  simulationAgentCardWithSource,
} from "../../../src/lib/dashboard/simulation-report-tabs.js";
import goldens from "../fixtures/simulation-agent-card-python-goldens.json" with {
  type: "json",
};

const hash = (html: string) => createHash("sha256").update(html).digest("hex");
let original: NodeJS.ProcessEnv, directory: string;
beforeEach(async () => {
  original = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "eq-sim-agent-card-"));
  for (const key of ["ORQ_WORKSPACE", "ORQ_WORKSPACE_SLUG", "ORQ_API_KEY"])
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
const native = (value: unknown): Parameters<typeof simulationAgentCard>[0] =>
  value === null
    ? null
    : (Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          item,
        ]),
      ) as Parameters<typeof simulationAgentCard>[0]);
for (const [index, row] of goldens.cases.entries())
  test(`Python simulation agent card ${index}`, async () => {
    const info = native(row.input);
    expect(
      hash(
        await simulationAgentCard(info, { experimentUrl: row.experimentUrl }),
      ),
    ).toBe(row.card);
    expect(
      hash(
        await simulationAgentCard(info, {
          bare: true,
          footerHtml: "<p>footer</p>",
          experimentUrl: row.experimentUrl,
        }),
      ),
    ).toBe(row.bare);
    for (const source of row.sources)
      expect(
        hash(
          await simulationAgentCardWithSource(
            info,
            { key: "original" },
            source.source,
            row.experimentUrl,
          ),
        ),
      ).toBe(source.expected);
  });
for (const [index, row] of goldens.previews.entries())
  test(`Python compact agent description ${index}`, () =>
    expect(agentDescriptionPreview(row.input)).toBe(row.expected));
