import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { textToolActivityChunks } from "../../../src/lib/insights/transcript.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-activity-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { trace: unknown; budget: number; chunks?: string[]; valid: boolean }[];
for (const [i, c] of gold.entries())
  test(`text tool activity ${i}`, () => {
    const trace = new TraceRecord(c.trace);
    if (!c.valid) {
      expect(() =>
        textToolActivityChunks(trace, {
          traceInputChars: 4096,
          budget: c.budget,
        }),
      ).toThrow();
      return;
    }
    expect(
      textToolActivityChunks(trace, {
        traceInputChars: 4096,
        budget: c.budget,
      }),
    ).toEqual(c.chunks ?? []);
  });

test("tool output is scrubbed before excerpts are cut", () => {
  const secret = "sk-" + "Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0";
  const trace = new TraceRecord({
    schemaVersion: 1,
    traceId: "t",
    spanId: "s",
    timestamp: "2026-11-10T00:00:00Z",
    project: "p",
    model: "m",
    provider: "p",
    status: "ok",
    product: "agents",
    traceType: "agent",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({ command: "echo ok" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c",
        content: "x".repeat(140) + secret + "y".repeat(400),
      },
    ],
  });
  const output = textToolActivityChunks(trace, { traceInputChars: 4096 }).join(
    "\n",
  );
  expect(output).not.toContain(secret);
  expect(output).not.toContain(secret.slice(0, 12));
});

test("questions reserve space before tool activity is packed", () => {
  const example = gold.find((c) => c.valid);
  if (!example) throw new Error("missing fixture");
  const trace = new TraceRecord(example.trace);
  expect(() =>
    textToolActivityChunks(trace, {
      traceInputChars: 100,
      budget: 100,
      questionPayloads: { q: { kind: "noul", instructions: "x".repeat(200) } },
    }),
  ).toThrow("state budget");
});
