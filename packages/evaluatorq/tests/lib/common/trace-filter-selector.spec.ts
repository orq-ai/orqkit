import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { ClassifyResponseSchema } from "../../../src/lib/common/judge.js";
import {
  questionsForCatalogue,
  selectionFromAnswers,
} from "../../../src/lib/trace-finder/filter-selector.js";
import { FacetCatalogueSchema } from "../../../src/lib/trace-finder/models.js";

interface Fixture {
  catalogue: unknown;
  query: string;
  choices: unknown;
  binary: unknown;
  questions: unknown;
  response: unknown;
  selection: unknown;
  errors: { input: unknown; ok: boolean }[];
}
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-filter-selector-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Fixture[];
const names = new Set([
  "projectId",
  "traceType",
  "agentName",
  "toolName",
  "noulThreshold",
]);
function wire(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        names.has(key)
          ? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
          : key,
        key === "criteria" ? item : wire(item),
      ]),
    );
  return value;
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return [...value].sort();
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
for (const [index, row] of fixtures.entries())
  test(`Python filter selection ${index}`, () => {
    const built = questionsForCatalogue(
      FacetCatalogueSchema.parse(row.catalogue),
      row.query,
    );
    expect<unknown>(built.choices).toEqual(row.choices);
    expect<unknown>(built.binaryValues).toEqual(row.binary);
    expect(wire(built.questions)).toEqual(row.questions);
    expect(
      sorted(
        wire(
          selectionFromAnswers(
            ClassifyResponseSchema.parse(row.response),
            built,
          ),
        ),
      ),
    ).toEqual(sorted(row.selection));
    for (const error of row.errors) {
      const run = () =>
        selectionFromAnswers(ClassifyResponseSchema.parse(error.input), built);
      if (error.ok) expect(run).not.toThrow();
      else expect(run).toThrow();
    }
  });
