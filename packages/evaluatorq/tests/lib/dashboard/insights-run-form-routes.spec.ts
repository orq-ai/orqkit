import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ModelInfo } from "../../../src/lib/common/model-catalogue.js";
import { BUILTIN } from "../../../src/lib/common/model-roles.js";
import { DashboardAuth } from "../../../src/lib/dashboard/auth.js";
import {
  getFinderExportsDir,
  InsightsLaunchSpec,
} from "../../../src/lib/dashboard/insights-launch.js";
import {
  type InsightsRouteDeps,
  insightsRoutes,
} from "../../../src/lib/dashboard/insights-routes.js";
import {
  INSIGHTS_MODEL_FIELDS,
  OFFERED_DIMENSIONS,
  OFFERED_LABELS,
  RUN_PRESETS,
  RunFormValues,
  renderRunForm,
} from "../../../src/lib/dashboard/insights-run-form.js";
import { csrfToken } from "../../../src/lib/dashboard/security.js";
import {
  type InsightsRunFields,
  InsightsRunSchema,
} from "../../../src/lib/insights/models.js";
import { CODING_LABELS, TASK_TYPE } from "../../../src/lib/insights/presets.js";
import { FacetCatalogueSchema } from "../../../src/lib/trace-finder/models.js";

type Row = Record<string, unknown>;
const SCRATCH = join(process.env.HOME ?? ".", "insights-run-form-tests");
const ENV_KEYS = [
  "EVALUATORQ_DIR",
  "EVALUATORQ_DASHBOARD_SETTINGS",
  "EVALUATORQ_SMART_MODEL",
  "EVALUATORQ_CLASSIFIER_MODEL",
  "EVALUATORQ_COMPILER_MODEL",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let root: string;
let runsDir: string;
let warnings: string[];
let warn: ReturnType<typeof spyOn<Console, "warn">>;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  runsDir = join(root, "insights");
  mkdirSync(runsDir, { recursive: true });
  process.env.EVALUATORQ_DIR = root;
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(root, "none.json");
  for (const key of ENV_KEYS.slice(2)) delete process.env[key];
  warnings = [];
  warn = spyOn(console, "warn").mockImplementation((...args) => {
    warnings.push(args.join(" "));
  });
});
afterEach(() => {
  warn.mockRestore();
  rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const AUTH = new DashboardAuth(
  "stored_api_key",
  "sk-test",
  "https://my.orq.ai",
);
const price = (modelType = "chat") =>
  new ModelInfo({
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    provider: "acme",
    supportsResponses: false,
    modelType,
  });

const frustration = {
  name: "user_frustration",
  kind: "score",
  instructions: "Rate frustration.",
  criteria: ["1 calm", "2 mild", "3 irritated", "4 frustrated", "5 angry"],
};
const custom = {
  name: "needs_follow_up",
  kind: "noul",
  instructions: "Should a human follow up?",
};

function savedRun(population: Row, config: Row = {}): InsightsRunFields {
  return InsightsRunSchema.parse({
    run_id: "saved-run",
    run_name: "Saved run",
    created_at: "2026-09-01T12:00:00+00:00",
    status: "completed",
    stage_failures: [],
    population,
    config: {
      labels: [frustration, custom],
      dimensions: ["intent", "failure"],
      coding_labels: [JSON.parse(JSON.stringify(TASK_TYPE))],
      ...config,
    },
    traces: [],
    dimensions: {},
    labels: {},
    priority: null,
    priority_reason: null,
    counts: { n_traces: 0 },
    warnings: [],
  }) as InsightsRunFields;
}

function routes(deps: InsightsRouteDeps = {}) {
  return insightsRoutes({
    runsDir: () => runsDir,
    finderDir: () => join(root, "finder-exports"),
    selectedAuth: async () => AUTH,
    loadCatalogue: async () => {
      throw new Error("no Orq in tests");
    },
    catalogueEntry: async () => null,
    modelGroups: async () => ({}),
    launch: async () => "run-9",
    ...deps,
  });
}

function encode(params: Row): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    for (const item of Array.isArray(v) ? v : [v]) out.append(k, String(item));
  return out;
}

async function get(
  path: string,
  params: Row = {},
  deps: InsightsRouteDeps = {},
) {
  const search = encode(params);
  const url = new URL(
    `http://localhost${path}${search.size ? `?${search}` : ""}`,
  );
  return (await routes(deps)(new Request(url.href), url)) as Response;
}

async function post(path: string, fields: Row, deps: InsightsRouteDeps = {}) {
  const url = new URL(`http://localhost${path}`);
  return (await routes(deps)(
    new Request(url.href, { method: "POST", body: encode(fields) }),
    url,
  )) as Response;
}

const PLAN = {
  source: "orq",
  limit: "100",
  labels: "made_errors",
  dimensions: "intent",
};
const COUNTS = () =>
  FacetCatalogueSchema.parse({
    value_counts: { status: { completed: 90, error: 30 } },
  });

function estimateDeps(
  info: ModelInfo | null,
  priced: string[] = [],
): InsightsRouteDeps {
  return {
    loadCatalogue: async () => COUNTS(),
    catalogueEntry: async (_auth, model) => {
      priced.push(model);
      return info;
    },
  };
}

// ---- form ----

test("defaults render three steps with every offered choice", async () => {
  const html = renderRunForm(await RunFormValues.defaults(), { csrf: "t" });
  expect(html.split('data-step="').length - 1).toBe(3);
  for (const source of ["orq", "file"])
    expect(html).toContain(`name="source" value="${source}"`);
  for (const retired of ["recent", "query", "finder", "snapshot"])
    expect(html).not.toContain(`name="source" value="${retired}"`);
  expect(html).toContain('name="source" value="orq" checked');
  for (const preset of RUN_PRESETS)
    expect(html).toContain(`data-preset="${preset.id}"`);
  for (const name of [
    ...OFFERED_LABELS,
    ...OFFERED_DIMENSIONS,
    ...CODING_LABELS.slice(1).map((spec) => spec.name),
  ])
    expect(html).toContain(`value="${name}"`);
  expect(html).toContain('id="insights-run-models"');
  expect(html).toContain('id="insights-run-estimate"');
  expect(html).toContain('data-mount="page"');
  expect(html).not.toContain('name="finder_export"');
  expect(html.split('type="file"').length - 1).toBe(1);
});

test("customer satisfaction says the priority matrix needs it", async () => {
  const html = renderRunForm(await RunFormValues.defaults(), { csrf: "t" });
  const toggle = html.slice(html.indexOf('value="customer_satisfaction"'));
  expect(toggle.slice(0, toggle.indexOf("</label>"))).toContain(
    "the priority matrix needs this",
  );
  expect(html).not.toContain('value="customer_satisfaction" checked');
});

test("defaults are the find-failures preset on recent traces", async () => {
  const values = await RunFormValues.defaults();
  expect([values.source, values.windowDays, values.limit]).toEqual([
    "recent",
    7,
    200,
  ]);
  expect(values.preset).toBe(RUN_PRESETS[0]?.id ?? null);
  expect([...values.labels]).toEqual([...(RUN_PRESETS[0]?.labels ?? [])]);
});

test("from run round-trips a saved run", async () => {
  const values = await RunFormValues.fromRun(
    savedRun({
      mode: "query",
      query: "refunds",
      window_days: 14,
      limit: 50,
      facets: { agent_name: ["a"] },
    }),
    runsDir,
  );
  expect(values.source).toBe("query");
  expect([values.query, values.windowDays, values.limit]).toEqual([
    "refunds",
    14,
    50,
  ]);
  expect([...values.facets.agentName]).toEqual(["a"]);
  expect([...values.dimensions]).toEqual(["intent", "failure"]);
  expect([...values.labels]).toEqual(["user_frustration"]);
  expect([...values.codingLabels]).toEqual(["task_type"]);
  expect(values.customLabels.map((spec) => spec.name)).toEqual([
    "needs_follow_up",
  ]);
  expect(values.name).toBe("Saved run");
  expect(values.error).toBeNull();
});

test("from run clears a missing file and asks for a fresh one", async () => {
  const missing = await RunFormValues.fromRun(
    savedRun({ mode: "snapshot", snapshot_path: join(root, "gone.json") }),
    runsDir,
  );
  expect(missing.source).toBe("snapshot");
  expect(missing.traceFile).toBe("");
  expect(missing.error).toContain("fresh file");
});

test.each([
  [{}, "recent"],
  [{ mode: "snapshot" }, "snapshot"],
  [{ mode: "export", snapshot_path: "/x.json" }, "snapshot"],
  [{ mode: "export", finder_export: "/x.json", query: "refunds" }, "finder"],
  [{ finder_export: "/x.json" }, "finder"],
  [{ mode: "finder" }, "finder"],
  [{ mode: "query" }, "query"],
  [{ query: "refunds" }, "query"],
  [{ mode: "export", query: "refunds" }, "query"],
  [{ mode: "export" }, "finder"],
  [{ mode: "filter" }, "recent"],
  [{ mode: "dataset" }, "recent"],
] as [Row, string][])(
  "saved population %j opens as %s",
  async (population, expected) => {
    const values = await RunFormValues.fromRun(savedRun(population), runsDir);
    expect(values.source as string).toBe(expected);
  },
);

test("from form reads query parameters and form data the same way", async () => {
  const pairs: [string, string][] = [
    ["source", "orq"],
    ["query", "refunds"],
    ["window_days", "3"],
    ["limit", "40"],
    ["facet_status", "error"],
    ["facet_status", "ok"],
    ["dimensions", "failure"],
    ["labels", "made_errors"],
    ["coding_labels", "outcome"],
    [
      "custom_labels_json",
      JSON.stringify([{ name: "q_one", kind: "noul", instructions: "Is it?" }]),
    ],
    ["mount", "dialog"],
  ];
  const form = new FormData();
  for (const [k, v] of pairs) form.append(k, v);
  const fromQuery = await RunFormValues.fromForm(new URLSearchParams(pairs));
  const fromPost = await RunFormValues.fromForm(form as never);
  expect(fromQuery.launchFields()).toEqual(fromPost.launchFields());
  expect(fromQuery.mount).toBe("dialog");
  expect(fromPost.mount).toBe("dialog");
  expect([...fromQuery.facets.status].sort()).toEqual(["error", "ok"]);
});

test("the review step loads a picker per model and the compiler only for a question", async () => {
  const defaults = await RunFormValues.defaults();
  const recent = renderRunForm(defaults, { csrf: "t" });
  const question = renderRunForm(
    defaults.with({ source: "query", query: "refunds" }),
    {
      csrf: "t",
    },
  );
  for (const field of ["summary_model", "classifier_model", "embedding_model"])
    expect(recent).toContain(`/insights/models?field=${field}`);
  expect(recent).toContain("data-compiler-model hidden");
  expect(question).not.toContain("data-compiler-model hidden");
  expect(question).toContain("/insights/models?field=compiler_model");
  expect(new Set(Object.keys(INSIGHTS_MODEL_FIELDS))).toEqual(
    new Set([
      "summaryModel",
      "classifierModel",
      "embeddingModel",
      "compilerModel",
    ]),
  );
});

test("model defaults come from the model roles", async () => {
  process.env.EVALUATORQ_SMART_MODEL = "acme/smart-9";
  process.env.EVALUATORQ_CLASSIFIER_MODEL = "acme/classifier-9";
  process.env.EVALUATORQ_COMPILER_MODEL = "acme/compiler-9";
  const values = await RunFormValues.defaults();
  expect(values.summaryModel).toBe("acme/smart-9");
  expect(values.embeddingModel).toBe(BUILTIN.embedding);
  expect([values.classifierModel, values.compilerModel]).toEqual([
    "acme/classifier-9",
    "acme/compiler-9",
  ]);
  expect(values.launchFields().classifier_model).toBe("acme/classifier-9");
});

test("from run prefills all four models", async () => {
  const values = await RunFormValues.fromRun(
    savedRun(
      { mode: "query", query: "refunds" },
      {
        summary_model: "acme/summary",
        classifier_model: "acme/classify",
        embedding_model: "acme/embed",
        compiler_model: "acme/compile",
      },
    ),
    runsDir,
  );
  expect([
    values.summaryModel,
    values.classifierModel,
    values.embeddingModel,
    values.compilerModel,
  ]).toEqual(["acme/summary", "acme/classify", "acme/embed", "acme/compile"]);
});

test("the Orq tab maps to recent when blank and query when asked", async () => {
  expect(
    (await RunFormValues.fromForm({ source: "orq", query: "   " })).source,
  ).toBe("recent");
  const asked = await RunFormValues.fromForm({
    source: "orq",
    query: "refunds",
  });
  expect([asked.source, asked.query]).toEqual(["query", "refunds"]);
});

test("the file tab takes its kind from the upload name or the exports folder", async () => {
  const uploads = join(runsDir, ".uploads");
  const hex = "a".repeat(32);
  const source = async (traceFile: string) =>
    (await RunFormValues.fromForm({ source: "file", trace_file: traceFile }))
      .source;
  expect(await source(join(uploads, `finder-${hex}.json`))).toBe("finder");
  expect(await source(join(uploads, `snapshot-${hex}.json`))).toBe("snapshot");
  expect(await source(join(getFinderExportsDir(), "trace-finder-7.json"))).toBe(
    "finder",
  );
  expect(await source(join(root, "claude-traces.json"))).toBe("snapshot");
  expect(await source("")).toBe("snapshot");
});

test.each(["recent", "query", "finder", "snapshot", "bogus"])(
  "only the three tabs are accepted, not %s",
  async (stale) => {
    await expect(RunFormValues.fromForm({ source: stale })).rejects.toThrow(
      "Choose Orq traces, Trace file or Local sessions",
    );
  },
);

test("fields of the other tab are dropped", async () => {
  const onFile = await RunFormValues.fromForm({
    source: "file",
    trace_file: "s.json",
    query: "refunds",
    facet_agent_name: "support-bot",
  });
  expect([onFile.query, [...onFile.facets.agentName]]).toEqual(["", []]);
  const onOrq = await RunFormValues.fromForm({
    source: "orq",
    trace_file: "s.json",
  });
  expect([onOrq.source, onOrq.traceFile]).toEqual(["recent", ""]);
});

test("the sessions source launches as a snapshot", async () => {
  const values = await RunFormValues.fromForm({
    source: "sessions",
    trace_file: "/runs/.uploads/snapshot-1.json",
    source_name: "2 local sessions",
    query: "stale",
  });
  expect([values.source, values.query]).toEqual(["sessions", ""]);
  const fields = values.launchFields();
  expect(fields.source).toBe("snapshot");
  expect(fields.snapshot_path).toBe("/runs/.uploads/snapshot-1.json");
  const html = renderRunForm(await RunFormValues.defaults(), { csrf: "t" });
  expect(html).toContain('name="source" value="sessions"');
});

test("a frozen sessions file is not reported as the selected trace snapshot", async () => {
  const path = "/runs/.uploads/snapshot-1.json";
  const defaults = await RunFormValues.defaults();
  const sessions = renderRunForm(
    defaults.with({
      source: "sessions",
      traceFile: path,
      sourceName: "2 local sessions",
    }),
    { csrf: "t" },
  );
  const snapshot = renderRunForm(
    defaults.with({ source: "snapshot", traceFile: path }),
    {
      csrf: "t",
    },
  );
  expect(sessions).not.toContain("Trace snapshot is ready.");
  expect(sessions).toContain("2 local sessions");
  expect(sessions).toContain('name="source" value="sessions" checked');
  expect(snapshot).toContain("Trace snapshot is ready.");
});

// ---- routes ----

test("a rejected start re-renders what the user entered", async () => {
  const data = {
    csrf: csrfToken(),
    source: "orq",
    query: "refunds",
    window_days: "21",
    limit: "0",
    facet_agent_name: "support-bot",
    dimensions: "intent",
    custom_labels_json: JSON.stringify([custom]),
  };
  const page = await post("/insights/runs", data);
  const fragment = await post("/insights/runs", { ...data, mount: "dialog" });
  expect([page.status, fragment.status]).toEqual([422, 422]);
  const pageText = await page.text();
  const fragmentText = await fragment.text();
  for (const text of [pageText, fragmentText]) {
    expect(text).toContain('value="21"');
    expect(text).toContain("support-bot");
    expect(text).toContain("needs_follow_up");
  }
  expect(pageText).toContain("<html");
  expect(fragmentText).not.toContain("<html");
  expect(fragmentText).toContain('data-mount="dialog"');
  expect(
    (await post("/insights/runs", { source: "orq", mount: "dialog" })).status,
  ).toBe(403);
});

test("the plan route returns the stage titles the launch uses", async () => {
  const response = await get("/insights/new/plan", {
    source: "orq",
    query: "refunds",
    labels: "made_errors",
    dimensions: "intent",
  });
  const expected = InsightsLaunchSpec.parseUnchecked({
    source: "query",
    query: "refunds",
    labels: ["made_errors"],
    dimensions: ["intent"],
  }).stages();
  expect(response.status).toBe(200);
  const text = await response.text();
  for (const [, title] of expected) expect(text).toContain(title);
});

test("the plan route reports the validation message", async () => {
  const response = await get("/insights/new/plan", {
    source: "file",
    dimensions: "intent",
  });
  expect(response.status).toBe(422);
  expect(await response.text()).toContain(
    "Browse to choose a trace file first",
  );
});

test("the plan shows traces, cost and a first-run time", async () => {
  const priced: string[] = [];
  const response = await get(
    "/insights/new/plan",
    PLAN,
    estimateDeps(price(), priced),
  );
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain("up to 100 traces");
  expect(text).toMatch(/\$\d/);
  expect(text).toContain("estimated after your first run");
  const spec = await RunFormValues.fromForm(PLAN);
  expect(new Set(priced)).toEqual(
    new Set([spec.summaryModel, spec.classifierModel, spec.embeddingModel]),
  );
});

test("the plan names the stage without a price", async () => {
  const text = await (
    await get("/insights/new/plan", PLAN, estimateDeps(null))
  ).text();
  expect(text).toContain("unknown");
  expect(text).toContain("summary has no price");
});

test("without facet counts the plan bounds traces by the limit", async () => {
  const text = await (await get("/insights/new/plan", PLAN)).text();
  expect(text).toContain("up to 100 traces");
  expect(text).toContain("the trace limit of 100");
});

test("the compact plan is one line without the stage table", async () => {
  const response = await get(
    "/insights/new/plan",
    { ...PLAN, compact: "1" },
    estimateDeps(price()),
  );
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain("up to 100 traces");
  expect(text).not.toContain("<table");
});

test("the compact plan reports an incomplete form without an error status", async () => {
  const response = await get("/insights/new/plan", {
    source: "file",
    dimensions: "intent",
    compact: "1",
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(
    "Browse to choose a trace file first",
  );
});

test("start launches the spec built from the submitted values", async () => {
  const launched: InsightsLaunchSpec[] = [];
  const response = await post(
    "/insights/runs",
    {
      csrf: csrfToken(),
      source: "orq",
      window_days: "5",
      limit: "30",
      facet_status: "error",
      labels: "made_errors",
      coding_labels: "outcome",
      dimensions: ["intent", "failure"],
    },
    {
      launch: async (spec) => {
        launched.push(spec);
        return "run-9";
      },
    },
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("run-9");
  const spec = launched[0] as InsightsLaunchSpec;
  expect([
    spec.windowDays,
    spec.limit,
    [...spec.labels],
    [...spec.codingLabels],
  ]).toEqual([5, 30, ["made_errors"], ["outcome"]]);
  expect([...spec.dimensions].sort()).toEqual(["failure", "intent"]);
  expect([...spec.facets.status]).toEqual(["error"]);
});

test("the models route loads the catalogue kind for the field", async () => {
  const seen: string[] = [];
  const deps: InsightsRouteDeps = {
    modelGroups: async (_auth, kind) => {
      seen.push(kind);
      return {
        openai: [
          "openai/text-embedding-3-small",
          "openai/text-embedding-3-large",
        ],
      };
    },
  };
  const embedding = await (
    await get(
      "/insights/models",
      {
        field: "embedding_model",
        embedding_model: "openai/text-embedding-3-large",
      },
      deps,
    )
  ).text();
  await get("/insights/models", { field: "summary_model" }, deps);
  await get("/insights/models", { field: "compiler_model" }, deps);
  const unknown = await (
    await get("/insights/models", { field: "apply_model" }, deps)
  ).text();
  expect(seen).toEqual(["embedding", "chat", "chat"]);
  expect(embedding).toContain("openai/text-embedding-3-large");
  expect(embedding).toContain('name="embedding_model"');
  expect(unknown).toBe("");
});

test("the models route falls back to a text input without a catalogue", async () => {
  const text = await (
    await get("/insights/models", {
      field: "classifier_model",
      classifier_model: "acme/c",
    })
  ).text();
  expect(text).toContain('type="text"');
  expect(text).toContain('value="acme/c"');
});

const startWith = (models: Row, deps: InsightsRouteDeps) =>
  post(
    "/insights/runs",
    {
      csrf: csrfToken(),
      source: "orq",
      labels: "made_errors",
      dimensions: "intent",
      ...models,
    },
    deps,
  );

test("start rejects models the catalogue says cannot do the job", async () => {
  const catalogue: Record<string, ModelInfo> = {
    "acme/embedder": price("embedding"),
    "acme/chat-2": price("chat"),
  };
  let launches = 0;
  const deps: InsightsRouteDeps = {
    catalogueEntry: async (_auth, model) => catalogue[model] ?? null,
    launch: async () => {
      launches++;
      return "run-9";
    },
  };
  const embedding = await startWith(
    { embedding_model: "acme/chat-2", summary_model: "acme/chat-2" },
    deps,
  );
  expect(embedding.status).toBe(422);
  expect(await embedding.text()).toContain("acme/chat-2");
  const accepted = await startWith(
    { embedding_model: "acme/embedder", summary_model: "acme/chat-2" },
    deps,
  );
  expect(accepted.status).toBe(303);
  expect(launches).toBe(1);
});

test("start accepts unchecked models", async () => {
  const launched: InsightsLaunchSpec[] = [];
  const response = await startWith(
    { classifier_model: "acme/typed", embedding_model: "acme/typed-embed" },
    {
      launch: async (spec) => {
        launched.push(spec);
        return "run-9";
      },
    },
  );
  expect(response.status).toBe(303);
  expect(launched[0]?.classifierModel).toBe("acme/typed");
});
