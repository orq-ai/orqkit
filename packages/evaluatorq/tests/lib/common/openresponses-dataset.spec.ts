import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendAssistantTurn,
  buildOpenResponsesRequest,
  loadOpenResponsesDataset,
  messagesFromOpenResponsesInput,
} from "../../../src/lib/integrations/openresponses/dataset.js";

test("OpenResponses helpers preserve conversation order and tool calls", () => {
  expect(
    buildOpenResponsesRequest({
      model: "m",
      prompt: "next",
      conversation: [{ role: "user", content: "first" }],
      instructions: "help",
    }),
  ).toEqual({
    model: "m",
    input: [
      { role: "user", content: "first" },
      { role: "user", content: "next" },
    ],
    instructions: "help",
  });
  expect(() => buildOpenResponsesRequest({ model: "m" })).toThrow(
    "at least one",
  );
  const result = appendAssistantTurn([], {
    output: [
      { type: "message", content: [{ type: "output_text", text: "answer" }] },
      {
        type: "function_call",
        name: "tool",
        call_id: "id",
        arguments: { x: 1 },
      },
    ],
  });
  expect(result).toEqual([
    { role: "assistant", content: "answer" },
    {
      type: "function_call",
      name: "tool",
      call_id: "id",
      arguments: '{"x": 1}',
    },
  ]);
  expect(
    messagesFromOpenResponsesInput([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "first " },
          { type: "output_text", text: "second" },
        ],
      },
      { type: "function_call", name: "tool" },
    ]),
  ).toEqual([{ role: "assistant", content: "first second" }]);
});
test("OpenResponses datasets load JSON and JSONL with row errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openresponses-data-"));
  try {
    const row = {
      input: {
        id: "s1",
        vulnerability: "prompt_injection",
        severity: "high",
        vulnerability_domain: "model",
        turn_type: "single",
        source: "unit-test",
      },
      openresponses_input: [{ role: "user", content: "complete attack" }],
    };
    const json = join(directory, "data.json"),
      jsonl = join(directory, "data.jsonl");
    await writeFile(json, JSON.stringify({ samples: [row] }));
    await writeFile(jsonl, `${JSON.stringify(row)}\n`);
    const dataset = await loadOpenResponsesDataset(json);
    expect(dataset.samples).toHaveLength(1);
    expect(dataset.samples[0]?.messages[0]?.content).toBe("complete attack");
    expect((await loadOpenResponsesDataset(jsonl)).samples).toHaveLength(1);
    await writeFile(jsonl, `${JSON.stringify(row)}\n{bad`);
    await expect(loadOpenResponsesDataset(jsonl)).rejects.toThrow("line 2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
