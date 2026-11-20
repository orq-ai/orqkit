import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ClassifyAnswerSchema,
  ClassifyQuestionSchema,
} from "../../../src/lib/common/judge.js";
import {
  mapLabelAnswer,
  matchKey,
  mergeLabelChunks,
  populationMatch,
  readLabelAnswers,
} from "../../../src/lib/insights/labeling.js";
import { LabelAnswerSchema } from "../../../src/lib/insights/models.js";
import { CompiledQuerySchema } from "../../../src/lib/trace-finder/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-label-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: { question: unknown; answer: unknown; expected: unknown }[];
  chunks: { name: string; answers: unknown[]; expected: unknown }[];
  keys: string[];
};
for (const [i, c] of gold.cases.entries())
  test(`label mapping ${i}`, () => {
    expect<unknown>(
      mapLabelAnswer(
        ClassifyQuestionSchema.parse(c.question),
        ClassifyAnswerSchema.parse(c.answer),
      ),
    ).toEqual(c.expected);
  });
for (const [i, c] of gold.chunks.entries())
  test(`label chunks ${i}`, () => {
    expect<unknown>(
      mergeLabelChunks(
        c.name,
        c.answers.map((a) => LabelAnswerSchema.parse(a)),
      ),
    ).toEqual(c.expected);
  });
test("population match keys match Python", () => {
  expect(
    [1, 2, 3].flatMap((n) =>
      Array.from({ length: n }, (_, i) => matchKey(i, n)),
    ),
  ).toEqual(gold.keys);
});

test("missing answers remain errors and population matching stays unknown", () => {
  const q = ClassifyQuestionSchema.parse({
    kind: "noul",
    instructions: "q",
    state: {},
    noulThreshold: 0.7,
  });
  const dimension = CompiledQuerySchema.parse({
    name: "match",
    task: q,
    selection: { kind: "values", values: [true] },
  });
  const questions = { label: q, __match__: q };
  const read = readLabelAnswers(questions, {});
  expect(Object.keys(read)).toEqual(["label"]);
  expect(read.label?.error).toBe("no answer returned for label 'label'");
  expect(populationMatch(questions, {}, ["__match__"], [dimension])).toBeNull();
  expect(
    populationMatch(
      questions,
      { __match__: ClassifyAnswerSchema.parse({ type: "noul", noul: 0.8 }) },
      ["__match__"],
      [dimension],
    ),
  ).toBe(true);
  expect(populationMatch({}, {}, [], [])).toBe(true);
  expect(() => populationMatch({}, {}, ["x"], [])).toThrow();
});
