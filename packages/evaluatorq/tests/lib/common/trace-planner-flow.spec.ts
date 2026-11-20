import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import type OpenAI from "openai";

import type { Orq } from "@orq-ai/node";

import { ClassifyResponseSchema } from "../../../src/lib/common/judge.js";
import { parseUsage } from "../../../src/lib/contracts.js";
import * as compiler from "../../../src/lib/trace-finder/compiler.js";
import * as selectors from "../../../src/lib/trace-finder/filter-selector.js";
import {
  FacetCatalogueSchema,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
} from "../../../src/lib/trace-finder/models.js";
import { planQuery } from "../../../src/lib/trace-finder/planner.js";

type Row = Record<string, unknown>;
type TestCase = {
  input: {
    query: string;
    population: unknown;
    compiled: Row;
    catalogues: Row[];
    selections: Row[];
    mode: "llm" | "llm+jev";
    within?: boolean;
    confirm?: string[];
    confirmError?: string[];
  };
  ok: boolean;
  expected: Row;
  calls: Row;
};
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-planner-flow-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { now: string; cases: TestCase[] };
function wire(value: unknown, key = ""): unknown {
  if (key === "elapsed_seconds" || key === "elapsedSeconds") return 0;
  if (value instanceof Date) return value.toISOString().replace(".000Z", "Z");
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map((item) => wire(item));
  if (typeof value === "string" && value.includes("T"))
    return value.replace(/\+00:00$/, "Z");
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name
          .replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
          .replace(/([a-z])(\d)/g, "$1_$2"),
        wire(item, name),
      ]),
    );
  return value;
}
function comparable(value: unknown): unknown {
  const output = wire(value) as Row;
  if (Array.isArray(output.model_calls))
    for (const usage of output.model_calls)
      if (usage && typeof usage === "object") {
        delete (usage as Row).prompt_tokens;
        delete (usage as Row).completion_tokens;
        delete (usage as Row).cost_usd;
      }
  return output;
}
for (const [index, row] of fixture.cases.entries())
  test(`Python planner flow ${index}`, async () => {
    const doc = row.input,
      calls: { compile: number; load: Row[]; select: Row[]; confirm: Row[] } = {
        compile: 0,
        load: [],
        select: [],
        confirm: [],
      };
    let loadIndex = 0,
      selectIndex = 0;
    const compile = spyOn(compiler, "compileQuery").mockImplementation(
      async () => {
        calls.compile++;
        return new compiler.CompiledPlan({
          ...doc.compiled,
          usages: (doc.compiled.usages as unknown[]).map((value) =>
            value === null ? null : parseUsage(value),
          ),
        });
      },
    );
    const select = async (
      _client: OpenAI,
      model: string,
      catalogue: ReturnType<typeof FacetCatalogueSchema.parse>,
      query: string,
    ) => {
      calls.select.push({ model, catalogue: wire(catalogue), query });
      const item = doc.selections[
        Math.min(selectIndex++, doc.selections.length - 1)
      ] as Row;
      if (item.error) throw new Error(String(item.error));
      return new selectors.FilterSelectionResult(
        new FacetSelection(item.selection ?? {}),
        {
          response: item.response
            ? ClassifyResponseSchema.parse(item.response)
            : null,
          numeric: item.numeric ? new NumericFilters(item.numeric) : null,
          time: item.time ? new compiler.TimeFilters(item.time) : null,
          usage: item.usage ? parseUsage(item.usage) : null,
        },
      );
    };
    const jev = spyOn(
        selectors,
        "selectFiltersWithResponse",
      ).mockImplementation(select),
      llm = spyOn(selectors, "selectLlmFiltersWithResponse").mockImplementation(
        select,
      ),
      warning = spyOn(console, "warn").mockImplementation(() => {}),
      info = spyOn(console, "info").mockImplementation(() => {});
    const orq = { _options: {}, _baseURL: null } as unknown as Orq;
    try {
      const pending = planQuery(
        doc.query,
        new PopulationRequest(doc.population),
        {
          client: {} as OpenAI,
          orq,
          compilerModel: "compiler",
          classifierModel: "jev",
          fastFilterModel: "fast",
          filterSelection: doc.mode,
          withinResults: doc.within ?? false,
          now: fixture.now,
          catalogueLoader: async (_client, options) => {
            calls.load.push({
              start: wire(options.start),
              end: wire(options.end),
              limit: options.limit,
            });
            const item = doc.catalogues[
              Math.min(loadIndex++, doc.catalogues.length - 1)
            ] as Row;
            if (item.error) throw new Error(String(item.error));
            return FacetCatalogueSchema.parse(item);
          },
          candidateConfirmer: async (_client, name, value, start, end) => {
            calls.confirm.push({
              name,
              value,
              start: wire(start),
              end: wire(end),
            });
            if (doc.confirmError?.includes(name))
              throw new Error("candidate failed");
            return doc.confirm?.includes(name) ?? false;
          },
        },
      );
      if (row.ok)
        expect(comparable(await pending)).toEqual(comparable(row.expected));
      else await expect(pending).rejects.toThrow();
      expect(wire(calls)).toEqual(row.calls);
    } finally {
      compile.mockRestore();
      jev.mockRestore();
      llm.mockRestore();
      warning.mockRestore();
      info.mockRestore();
    }
  });
