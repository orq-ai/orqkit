import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  FacetCatalogueSchema,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
} from "../../../src/lib/trace-finder/models.js";
import * as planner from "../../../src/lib/trace-finder/planner.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/trace-planner-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as Record<
  string,
  {
    args: unknown[];
    kwargs: Record<string, unknown>;
    ok: boolean;
    expected?: unknown;
  }[]
>;
function wire(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        wire(item),
      ]),
    );
  return value;
}
function facets(value: unknown): unknown {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      Array.isArray(item) ? [...item].sort() : item,
    ]),
  );
}
for (const [group, rows] of Object.entries(fixture))
  for (const [index, row] of rows.entries())
    test(`Python planner ${group} ${index}`, () => {
      const a = row.args,
        k = row.kwargs,
        run = () => {
          if (group === "facets")
            return facets(
              wire(
                planner.mergeFacets(
                  new FacetSelection(a[0]),
                  new FacetSelection(a[1]),
                ),
              ),
            );
          if (group === "numeric")
            return wire(
              planner.mergeNumeric(
                new NumericFilters(a[0]),
                new NumericFilters(a[1]),
              ),
            );
          if (group === "scope")
            return planner.effectiveTimeScope(
              new PopulationRequest(a[0]),
              a[1] as readonly [string, string] | null,
              {
                withinResults: k.within_results as boolean,
                forceEmpty: k.force_empty as boolean,
              },
            );
          if (group === "window")
            return planner.candidateWindow(
              new PopulationRequest(a[0]),
              a[1] as readonly [string, string] | null,
              {
                withinResults: k.within_results as boolean,
                fallbackStart: k.fallback_start as string,
                fallbackEnd: k.fallback_end as string,
              },
            );
          if (group === "later")
            return planner.later(a[0] as string | null, a[1] as string | null);
          if (group === "earlier")
            return planner.earlier(
              a[0] as string | null,
              a[1] as string | null,
            );
          if (group === "candidates")
            return planner.literalCandidates(
              a[0] as string,
              FacetCatalogueSchema.parse(a[1]),
            );
          if (group === "selector")
            return planner.selectorQuery(
              a[0] as string,
              a[1] as planner.LiteralCandidate[],
              FacetCatalogueSchema.parse(a[2]),
            );
          throw new Error(group);
        };
      if (row.ok)
        expect(run()).toEqual(
          group === "facets" ? facets(row.expected) : row.expected,
        );
      else expect(run).toThrow();
    });
