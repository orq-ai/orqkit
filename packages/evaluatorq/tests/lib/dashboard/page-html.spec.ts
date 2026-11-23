import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { pageHtml } from "../../../src/lib/dashboard/trace-finder/views.js";
import {
  RunRequestSchema,
  RunSnapshot,
} from "../../../src/lib/trace-finder/models.js";
import { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

const cases = JSON.parse(
  readFileSync(
    new URL("../fixtures/page-html-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  snap: string;
  api: boolean;
  kw: Record<string, unknown>;
  mode: string;
  html: string;
}[];

// Python RunRequest(query='angry <x>', mode='immediate', population=PopulationRequest()).model_dump(mode="json")
const REQUEST = {
  query: "angry <x>",
  mode: "immediate",
  population: {
    start: null,
    end: null,
    time_origin: "default",
    end_exclusive: false,
    facets: {
      project: [],
      project_id: null,
      model: [],
      provider: [],
      status: [],
      product: [],
      trace_type: [],
      agent_name: [],
      tool_name: [],
    },
    numeric: {
      tokens_min: null,
      tokens_max: null,
      duration_ms_min: null,
      duration_ms_max: null,
    },
    limit: 500,
  },
  parallelism: 100,
};

const normalize = (html: string) =>
  html
    .replace(/name="csrf" value="[^"]*"/g, 'name="csrf" value=""')
    .replace(/data-render-key="[0-9a-f]{8}"/g, 'data-render-key=""')
    .replace(/\?v=[0-9a-f]{12}/g, "?v=")
    // The default explorer range ends at the current time, which differs between the two recordings.
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/g, "T")
    .replace(/value="\d{4}-\d\d-\d\d"/g, 'value="D"')
    .replace(/value="\d\d:\d\d:\d\d"/g, 'value="H"');

for (const [i, c] of cases.entries())
  test(`page html matches Python: ${c.snap} api=${c.api} mode=${c.mode} (${i})`, async () => {
    const snapshot =
      c.snap === "req"
        ? new RunSnapshot({
            state: "completed",
            request: RunRequestSchema.parse(REQUEST),
          })
        : new RunSnapshot();
    const html = await pageHtml(
      snapshot,
      new DashboardSettings({ askAiMode: c.mode }),
      {
        apiAvailable: c.api,
        error: (c.kw.error as string | undefined) ?? null,
        hasRows: (c.kw.has_rows as boolean | undefined) ?? false,
        autoScopePending:
          (c.kw.auto_scope_pending as boolean | undefined) ?? false,
        pending: (c.kw.pending as boolean | undefined) ?? false,
        explorerHtml: (c.kw.explorer_html as string | undefined) ?? "",
      },
    );
    expect(normalize(html)).toBe(normalize(c.html));
  });
