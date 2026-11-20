import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { ResponsesConversation } from "../../../src/lib/formats/responses.js";
import { finalMetrics } from "../../../src/lib/formats/shared.js";
import goldens from "../fixtures/atif-conversion-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>,
  debug: ReturnType<typeof spyOn<typeof console, "debug">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  debug = spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  debug.mockRestore();
});
for (const [i, row] of goldens.forward.entries())
  test(`Python Responses to ATIF and back ${i}`, () => {
    const convert = () => {
      const traj = new ResponsesConversation(row.input).toAtif({
        agentName: row.options.agent_name,
        agentVersion: row.options.agent_version,
        sessionId: row.options.session_id,
      });
      const roundtrip = traj.toResponses();
      return { traj, roundtrip };
    };
    if (!row.ok) expect(convert).toThrow();
    else {
      const { traj, roundtrip } = convert();
      expect(traj.toModelDict()).toEqual(
        row.expected as Record<string, unknown>,
      );
      expect<unknown>(roundtrip).toEqual(row.roundtrip);
    }
  });
for (const [i, row] of goldens.reverse.entries())
  test(`Python ATIF to Responses and back ${i}`, () => {
    const convert = () => {
      const conv = new AtifTrajectory(row.input).toResponses();
      return { conv, roundtrip: conv.toAtif() };
    };
    if (!row.ok) expect(convert).toThrow();
    else {
      const { conv, roundtrip } = convert();
      expect<unknown>(conv).toEqual(row.expected);
      expect(roundtrip.toModelDict()).toEqual(
        row.roundtrip as Record<string, unknown>,
      );
    }
  });
const distinctHelpers = [
  ...new Map(
    goldens.helpers.map((row) => [
      JSON.stringify([
        row.input.steps.map(
          (step) => (step as Record<string, unknown>).metrics ?? null,
        ),
        row.expected,
      ]),
      row,
    ]),
  ).values(),
];
for (const [i, row] of distinctHelpers.entries())
  test(`Python ATIF final metrics ${i}`, () => {
    const traj = new AtifTrajectory(row.input),
      metrics = finalMetrics(traj.steps);
    expect<unknown>(metrics).toEqual(
      row.expected === null
        ? null
        : new AtifTrajectory({ ...row.input, final_metrics: row.expected })
            .finalMetrics,
    );
  });
