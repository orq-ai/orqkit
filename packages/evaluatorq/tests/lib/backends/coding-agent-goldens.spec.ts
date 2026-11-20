import {
  afterEach,
  beforeEach,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type AgentName,
  buildArgv,
  describeLastEvent,
  type Launcher,
  messageToDict,
  parseEvents,
  parseJsonl,
  renderPrompt,
} from "../../../src/lib/backends/coding-agent.js";
import { MessageSchema, type Usage } from "../../../src/lib/contracts.js";
import goldens from "./fixtures/coding-agent-python-goldens.json" with {
  type: "json",
};

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const USAGE_KEYS: Record<string, keyof Usage> = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  totalTokens: "totalTokens",
  cachedTokens: "cachedTokens",
  cacheCreationTokens: "cacheCreationTokens",
  cacheCreation1HTokens: "cacheCreation1hTokens",
  cacheCreation5MTokens: "cacheCreation5mTokens",
  reasoningTokens: "reasoningTokens",
  inputCost: "inputCost",
  outputCost: "outputCost",
  totalCost: "totalCost",
  calls: "calls",
  pricedCalls: "pricedCalls",
};

function pythonUsage(
  raw: Record<string, unknown> | null,
): Partial<Usage> | null {
  if (raw === null) return null;
  return Object.fromEntries(
    Object.entries(USAGE_KEYS).map(([py, ts]) => [ts, raw[py]]),
  ) as Partial<Usage>;
}

test("source matches the Python checkout the goldens came from", () => {
  expect(goldens.source).toBe("a59c3a862");
});

test("parsers match Python", () => {
  for (const g of goldens.parsers) {
    warn.mockClear();
    const events = g.fixture
      ? parseJsonl(
          readFileSync(
            join(import.meta.dir, "fixtures", `${g.fixture}.jsonl`),
            "utf8",
          ),
        )
      : (g.events as Record<string, unknown>[]);
    const turn = parseEvents(g.agent as AgentName, events);
    const e = g.expected;
    const label = `${g.agent} ${g.fixture ?? JSON.stringify(g.events).slice(0, 80)}`;
    expect({ label, value: turn.text }).toEqual({ label, value: e.text });
    expect({ label, value: turn.sessionId }).toEqual({
      label,
      value: e.session_id,
    });
    expect({ label, value: turn.model }).toEqual({ label, value: e.model });
    expect({ label, value: turn.costUsd }).toEqual({
      label,
      value: e.cost_usd,
    });
    expect({ label, value: turn.agentError }).toEqual({
      label,
      value: e.agent_error,
    });
    expect({ label, value: turn.usage }).toEqual({
      label,
      value: pythonUsage(e.usage as Record<string, unknown> | null) as Usage,
    });
    expect({
      label,
      value: turn.toolCalls.map(
        ({ id, call_id, name, arguments: a, status, result }) => ({
          id,
          call_id,
          name,
          arguments: a,
          status,
          result,
        }),
      ),
    }).toEqual({ label, value: e.tool_calls as never });
    expect({ label, value: warn.mock.calls.map((c) => c[0]) }).toEqual({
      label,
      value: g.warnings,
    });
  }
});

test("buildArgv matches Python", () => {
  for (const g of goldens.argv) {
    const i = g.input;
    const run = () =>
      buildArgv({
        agent: i.agent as AgentName,
        launcher: i.launcher as Launcher,
        model: i.model,
        permissionMode: i.permission_mode,
        systemPrompt: i.system_prompt,
        extraArgs: i.extra_args,
        orq: i.orq,
        prompt: i.prompt,
      });
    if (!g.ok) {
      expect(run).toThrow(g.error as string);
      continue;
    }
    expect(run()).toEqual([g.argv as string[], g.stdin as string | null]);
  }
});

test("renderPrompt and messageToDict match Python", () => {
  for (const g of goldens.prompts) {
    const messages = g.messages.map((m) => MessageSchema.parse(m));
    expect(
      renderPrompt(messages, {
        systemPrompt: g.system_prompt,
        inlineSystem: g.inline_system,
      }),
    ).toBe(g.expected);
    expect(messages.map(messageToDict)).toEqual(g.dicts);
  }
});

test("describeLastEvent matches Python", () => {
  for (const g of goldens.describe)
    expect(describeLastEvent(g.input)).toBe(g.expected);
});
