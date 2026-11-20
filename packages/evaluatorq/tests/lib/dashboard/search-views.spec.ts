import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  searchFragment,
  searchPageHtml,
} from "../../../src/lib/dashboard/trace-finder/search-views.js";
import {
  CompiledQuerySchema,
  FacetSelection,
  NumericFilters,
  RunRequestSchema,
  RunSnapshot,
} from "../../../src/lib/trace-finder/models.js";
import { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

type Json = Record<string, unknown>;
const g = JSON.parse(
  readFileSync(
    new URL("../fixtures/search-views-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  snapshots: Record<string, Json>;
  settings: Record<string, Json>;
  fragments: { snap: string; settings: string; kw: Json; html: string }[];
  pages: { snap: string; api: boolean; html: string }[];
};

const normalize = (html: string) =>
  html
    .replace(/name="csrf" value="[^"]*"/g, 'name="csrf" value=""')
    .replace(/\?v=[0-9a-f]{12}/g, "?v=");

function snapshot(name: string): RunSnapshot {
  const s = g.snapshots[name] as Json;
  return new RunSnapshot({
    state: s.state as never,
    total: s.total as number,
    error: s.error as string | null,
    request: s.request ? RunRequestSchema.parse(s.request) : null,
    dimensions: s.dimensions
      ? (s.dimensions as Json[]).map((d) => CompiledQuerySchema.parse(d))
      : null,
    explicitFilters: new FacetSelection(s.explicit_filters),
    explicitNumeric: new NumericFilters(s.explicit_numeric),
    generatedFilters: new FacetSelection(s.generated_filters),
  });
}

function settings(name: string): DashboardSettings {
  const s = g.settings[name] as Json;
  return new DashboardSettings({
    orqProjectId: s.orq_project_id as string | null,
    orqProjectName: s.orq_project_name as string | null,
    windowDays: s.window_days as number,
    limit: s.limit as number,
    parallelism: s.parallelism as number,
  } as never);
}

for (const [i, c] of g.fragments.entries())
  test(`search fragment matches Python: ${c.snap} / ${c.settings} (${i})`, () => {
    const html = searchFragment(snapshot(c.snap), settings(c.settings), {
      error: (c.kw.error as string | undefined) ?? null,
      apiAvailable: (c.kw.api_available as boolean | undefined) ?? true,
      pending: (c.kw.pending as boolean | undefined) ?? false,
    });
    expect(normalize(html)).toBe(normalize(c.html));
  });

for (const [i, c] of g.pages.entries())
  test(`search page matches Python: ${c.snap} (${i})`, async () => {
    const html = await searchPageHtml(snapshot(c.snap), settings("plain"), {
      apiAvailable: c.api,
      error: c.snap === "idle" ? "E" : null,
    });
    expect(normalize(html)).toBe(normalize(c.html));
  });
