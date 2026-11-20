import { expect, test } from "bun:test";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { parsePythonJson, pythonJson } from "../../../src/lib/formats/json.js";
import { atifToolArguments } from "../../../src/lib/formats/shared.js";
import goldens from "../fixtures/format-json-parser-goldens.json" with {
  type: "json",
};

for (const [i, row] of goldens.entries())
  test(`Python format JSON parsing ${i}`, () => {
    if (!row.ok) expect(() => parsePythonJson(row.text)).toThrow();
    else
      expect(pythonJson(parsePythonJson(row.text))).toBe(
        row.expected as string,
      );
  });
test("ATIF reads its non-finite metric output and retains non-finite tool arguments", () => {
  const trajectory = new AtifTrajectory({
    agent: { name: "a", version: "1" },
    steps: [
      {
        stepId: 1,
        source: "agent",
        message: "",
        metrics: { costUsd: Infinity, logprobs: [NaN, -Infinity] },
      },
    ],
  });
  const loaded = AtifTrajectory.fromJson(trajectory.toJson());
  expect(loaded.steps[0]?.metrics?.costUsd).toBe(Infinity);
  expect(loaded.steps[0]?.metrics?.logprobs?.[0]).toBeNaN();
  const [args, raw] = atifToolArguments('{"value":NaN}', "f");
  expect(args.value).toBeNaN();
  expect(raw).toBeNull();
  const proto = parsePythonJson('{"__proto__":{"safe":true}}') as Record<
    string,
    unknown
  >;
  expect(Object.hasOwn(proto, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
});
