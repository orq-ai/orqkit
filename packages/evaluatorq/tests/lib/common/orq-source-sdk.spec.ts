import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { Orq } from "@orq-ai/node";

import { ensureTraceDocument } from "../../../src/lib/common/trace-document.js";
import { computeSignals } from "../../../src/lib/signals/registry.js";
import {
  FacetSelection,
  NumericFilters,
} from "../../../src/lib/trace-finder/models.js";
import { OrqTraceSource } from "../../../src/lib/trace-finder/orq-source.js";

let mode = "legacy",
  requests: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }[] = [];
const stamp = "2026-11-10T10:00:00.000123Z",
  ended = "2026-11-10T10:00:01.000456Z";
function queryRow(id: string) {
  return {
    object: "trace",
    trace_id: id,
    leading_span_id: "root",
    project_id: "p",
    status: "ok",
    product: "agents",
    type: "span.agent",
    models: ["requested"],
    providers: ["provider"],
    started_at: stamp,
    ended_at: ended,
    agent: mode === "legacy" ? "legacy-agent" : { name: "agent" },
    attributes: {
      gen_ai: {
        input: { messages: [{ role: "user", content: `PRIVATE-${id}` }] },
        output: {
          messages:
            mode === "tools"
              ? [
                  {
                    role: "assistant",
                    content: "work",
                    tool_calls: [
                      { id: "c", function: { name: "f", arguments: "{}" } },
                    ],
                  },
                  { role: "tool", tool_call_id: "c", content: "done" },
                ]
              : [{ role: "assistant", content: "answer" }],
        },
        response: { model: "served" },
      },
    },
  };
}
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname,
      body =
        request.method === "POST"
          ? ((await request.json()) as Record<string, unknown>)
          : null;
    requests.push({ path, body, method: request.method });
    if (path === "/v2/projects")
      return Response.json({
        object: "list",
        data: [
          {
            project_id: "p",
            name: "Project",
            key: "project",
            is_archived: false,
            is_default: true,
            teams: [],
            created_at: stamp,
            updated_at: stamp,
          },
        ],
        has_more: false,
      });
    if (path === "/v3/traces/query") {
      const id = String(body?.oql).includes('"one"')
        ? "one"
        : String(body?.oql).includes('"two"')
          ? "two"
          : "t";
      if (mode === "bad-query")
        return Response.json({
          search: {
            data: [
              { agent: "legacy", messages: [{ content: "PRIVATE-INVALID" }] },
            ],
            has_more: false,
          },
        });
      return Response.json({
        object: "query",
        search: { object: "list", data: [queryRow(id)], has_more: false },
      });
    }
    if (path === "/v3/traces/t/spans")
      return Response.json({
        data: [
          { trace_id: "t", span_id: "root", type: "span.responses" },
          {
            trace_id: "t",
            span_id: "tool",
            parent_span_id: "root",
            type: "span.tool",
            status: "error",
            attributes: { "gen_ai.tool.call.id": "c" },
          },
          {
            trace_id: "t",
            span_id: "sibling",
            type: "span.tool",
            attributes: { "gen_ai.tool.call.id": "c" },
          },
        ],
        has_more: false,
      });
    if (path.startsWith("/v3/traces/t/spans/")) {
      const id = path.split("/").at(-1);
      if (mode === "wrong-span")
        return Response.json({
          span: {
            summary: { trace_id: "other", span_id: "wrong" },
            attributes: { secret: "PRIVATE-WRONG" },
          },
        });
      return Response.json({
        span: {
          summary: {
            trace_id: "t",
            span_id: id,
            type: id === "root" ? "span.responses" : "span.tool",
            status: id === "tool" ? "error" : "ok",
          },
          attributes:
            id === "tool"
              ? {
                  "tool.status": "error",
                  "error.type": "Failure",
                  otlp: { status: { message: "tool failed" } },
                }
              : {
                  "openresponses.response": {
                    output: [
                      {
                        type: "function_call",
                        call_id: "c",
                        name: "f",
                        arguments: "{}",
                      },
                    ],
                    usage: { input_tokens: 10, output_tokens: 3 },
                  },
                  "openresponses.request": {
                    tools: [{ type: "function", name: "f" }],
                  },
                },
        },
      });
    }
    return Response.json(
      { error: { message: "unexpected request" } },
      { status: 404 },
    );
  },
});
afterAll(() => server.stop(true));
const client = () =>
  new Orq({
    apiKey: "synthetic-local-sdk",
    serverURL: `http://127.0.0.1:${server.port}`,
    timeoutMs: 1000,
  });
const options = () => ({
  start: "2026-11-09T00:00:00Z",
  end: "2026-11-11T00:00:00Z",
  limit: 1,
  facets: new FacetSelection(),
  numeric: new NumericFilters(),
});
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  mode = "legacy";
  requests = [];
  warn = spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.ORQ_DEBUG;
});
afterEach(() => {
  warn.mockRestore();
  delete process.env.ORQ_DEBUG;
});
test("real SDK captures legacy agent responses and preserves full messages and microseconds", async () => {
  const source = new OrqTraceSource(client());
  try {
    const snapshot = await source.loadAsync(options());
    expect(snapshot.traces.length).toBe(1);
    expect(snapshot.traces[0]?.messages).toEqual([
      { role: "user", content: "PRIVATE-t" },
      { role: "assistant", content: "answer" },
    ]);
    expect(snapshot.traces[0]?.timestamp).toBe(ended);
    expect(snapshot.traces[0]?.model).toBe("served");
    expect(requests.map((r) => r.path)).toEqual([
      "/v2/projects",
      "/v3/traces/query",
    ]);
    expect(warn).not.toHaveBeenCalled();
    process.env.ORQ_DEBUG = "1";
    await source.loadAsync(options());
    expect(warn).toHaveBeenCalled();
  } finally {
    source.close();
  }
});
test("successful SDK decoding still uses raw timestamps and summary attributes", async () => {
  mode = "clean";
  const source = new OrqTraceSource(client());
  try {
    const rows = await source.search(options());
    expect(rows[0]?.startedAt).toBe(stamp);
    expect(rows[0]?.raw.attributes).toBeDefined();
    const snapshot = await source.loadAsync(options());
    expect(snapshot.traces[0]?.timestamp).toBe(ended);
    expect(snapshot.traces[0]?.messages.length).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    source.close();
  }
});
test("raw response markers isolate simultaneous searches sharing one SDK", async () => {
  const sdk = client(),
    a = new OrqTraceSource(sdk),
    b = new OrqTraceSource(sdk);
  try {
    const [one, two] = await Promise.all([
      a.search({
        ...options(),
        facets: new FacetSelection({ model: ["one"] }),
      }),
      b.search({
        ...options(),
        facets: new FacetSelection({ model: ["two"] }),
      }),
    ]);
    expect(one.map((r) => r.traceId)).toEqual(["one"]);
    expect(two.map((r) => r.traceId)).toEqual(["two"]);
  } finally {
    a.close();
    b.close();
  }
});
test("capture registration stays bounded across source lifecycles", async () => {
  const sdk = client(),
    before = sdk._options.hooks?.afterSuccessHooks.length ?? 0,
    a = new OrqTraceSource(sdk),
    b = new OrqTraceSource(sdk);
  expect(sdk._options.hooks?.afterSuccessHooks.length).toBe(before + 1);
  a.close();
  try {
    expect((await b.search(options())).length).toBe(1);
  } finally {
    b.close();
  }
  const c = new OrqTraceSource(sdk);
  try {
    expect(sdk._options.hooks?.afterSuccessHooks.length).toBe(before + 1);
    expect((await c.search(options())).length).toBe(1);
  } finally {
    c.close();
  }
});
test("SDK validation recovery rejects missing identities and mismatched span details", async () => {
  process.env.ORQ_DEBUG = "1";
  const source = new OrqTraceSource(client());
  try {
    mode = "bad-query";
    await expect(source.loadAsync(options())).rejects.toThrow(
      "invalid trace payload",
    );
    mode = "wrong-span";
    await expect(
      source.firstErrorMessage("t", [{ span_id: "tool", status: "error" }]),
    ).rejects.toThrow("Invalid raw trace payload");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("PRIVATE-INVALID");
  } finally {
    source.close();
  }
});
test("raw span summaries support scoped enrichment, error details and deterministic signals", async () => {
  mode = "tools";
  const source = new OrqTraceSource(client());
  try {
    const snapshot = await source.loadAsync(options()),
      enriched = await source.enrichSelectedSignalSpans(snapshot.traces),
      record = enriched[0];
    expect(record?.captureMetadata.signal_tool_spans).toEqual({
      c: { status: "error", error_type: "Failure" },
    });
    expect(requests.some((r) => r.path.endsWith("/spans/sibling"))).toBe(false);
    const report = computeSignals(
      ensureTraceDocument(record as TraceRecordLike).trajectory,
    );
    expect(report.results.tool_call_count?.value).toBe(1);
    expect(report.results.tool_error_count?.value).toBe(1);
    expect(
      (record?.captureMetadata.signal_span_coverage as Record<string, unknown>)
        .selected_data_correlated,
    ).toBe(true);
    expect(
      await source.firstErrorMessage("t", await source.listSpans("t")),
    ).toBe("tool failed");
  } finally {
    source.close();
  }
});
type TraceRecordLike =
  import("../../../src/lib/trace-finder/models.js").TraceRecord;
