import { expect, test } from "bun:test";

import OpenAI from "openai";

import { Orq } from "@orq-ai/node";

import {
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  RunRequestSchema,
} from "../../../src/lib/trace-finder/models.js";
import { buildRunStore } from "../../../src/lib/trace-finder/pipeline.js";
import { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

test("pipeline loads SDK v3 traces and classifies a filter-only run without model calls", async () => {
  const seen: string[] = [];
  let cleanup = 0,
    modelCalls = 0;
  const stamp = "2026-11-10T10:00:00.000123Z";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push(path);
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
      if (path === "/v3/traces/query")
        return Response.json({
          object: "query",
          search: {
            object: "list",
            data: [
              {
                object: "trace",
                trace_id: "t",
                leading_span_id: "root",
                project_id: "p",
                status: "ok",
                product: "agents",
                type: "span.agent",
                models: ["requested"],
                providers: ["provider"],
                started_at: stamp,
                ended_at: "2026-11-10T10:00:01.000456Z",
                agent: { name: "agent" },
                attributes: {
                  gen_ai: {
                    input: { messages: [{ role: "user", content: "hello" }] },
                    output: {
                      messages: [{ role: "assistant", content: "answer" }],
                    },
                  },
                },
              },
            ],
            has_more: false,
          },
        });
      if (path === "/v3/traces/t/spans/root")
        return Response.json({
          span: {
            summary: {
              trace_id: "t",
              span_id: "root",
              type: "span.responses",
              status: "ok",
            },
            attributes: {},
          },
        });
      return Response.json(
        { error: { message: "unexpected path" } },
        { status: 404 },
      );
    },
  });
  const orq = new Orq({
    apiKey: "synthetic",
    serverURL: `http://127.0.0.1:${server.port}`,
    timeoutMs: 1000,
  });
  const client = new OpenAI({
    apiKey: "synthetic",
    baseURL: `http://127.0.0.1:${server.port}`,
    fetch: async () => {
      modelCalls++;
      throw new Error("unexpected model call");
    },
  });
  const store = buildRunStore(
    new DashboardSettings({ traceInputChars: 4096 }),
    {
      client,
      orq,
      cleanup: () => {
        cleanup++;
      },
    },
  );
  try {
    expect(store.explorer).not.toBeNull();
    const req = RunRequestSchema.parse({
      query: "all traces",
      mode: "immediate",
      population: new PopulationRequest({
        start: "2026-11-09T00:00:00Z",
        end: "2026-11-11T00:00:00Z",
        limit: 1,
        facets: new FacetSelection(),
        numeric: new NumericFilters(),
      }),
      parallelism: 1,
    });
    await store.start(req, []);
    let result = await store.snapshot();
    for (let i = 0; i < 100 && result.state === "classifying"; i++) {
      await new Promise((r) => setTimeout(r, 1));
      result = await store.snapshot();
    }
    expect(result.state).toBe("completed");
    expect(result.traceIds).toEqual(["t"]);
    expect(result.results.t?.matched).toBe(true);
    expect(result.traces[0]?.messages).toHaveLength(2);
    expect(seen).toContain("/v3/traces/query");
    expect(modelCalls).toBe(0);
  } finally {
    await store.close();
    await store.close();
    server.stop(true);
  }
  expect(cleanup).toBe(1);
});
