import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  CompiledPlan,
  classificationLegend,
  compilerToDomain,
  dimensionToDomain,
  normalizeGeneratedTime,
  TimeFilters,
  tightenStrictBounds,
} from "../../../src/lib/trace-finder/compiler.js";
import {
  NumericFilters,
  PopulationRequest,
} from "../../../src/lib/trace-finder/models.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/trace-compiler-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as Record<
  string,
  { input: Record<string, unknown>; ok: boolean; expected?: unknown }[]
>;
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        key === "criteria" ? item : wire(item),
      ]),
    );
  return value;
}
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [group, rows] of Object.entries(fixture))
  for (const [index, row] of rows.entries())
    test(`Python compiler ${group} ${index}`, () => {
      const run = () => {
        const d = row.input;
        if (group === "time") return new TimeFilters(d);
        if (group === "plans")
          return JSON.parse(JSON.stringify(new CompiledPlan(d)));
        if (group === "bounds")
          return tightenStrictBounds(
            d.query as string,
            new NumericFilters(d.numeric),
          );
        if (group === "dimensions") {
          const result = dimensionToDomain(d);
          return [result, classificationLegend(result)];
        }
        if (group === "compilers") return compilerToDomain(d);
        if (group === "normalizations")
          return normalizeGeneratedTime(
            d.generated === null ? null : new TimeFilters(d.generated),
            {
              population: new PopulationRequest(d.population),
              withinResults: d.within_results as boolean,
              reference: d.reference as string,
              selectorOutput: d.selector_output as boolean,
            },
          );
        throw new Error(group);
      };
      if (row.ok) expect(wire(run())).toEqual(row.expected);
      else expect(run).toThrow();
    });
