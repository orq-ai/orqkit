import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import {
  AgentResponse,
  AgentTarget,
  type Message,
  MessageSchema,
  textOutputItem,
  toolCallOutputItem,
  UsageSchema,
} from "../../../src/lib/contracts.js";
import {
  datapointsFromTraces,
  ensureTargetCanBacktrack,
  parseTraceSeed,
  replaySeedContext,
  seedMessages,
  TraceStartSchema,
  targetHistoryMode,
} from "../../../src/lib/redteam/index.js";
import { Trace } from "../../../src/lib/trace.js";
import goldens from "../fixtures/trace-seed-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [index, fixture] of goldens.cases.entries())
  it(`matches Python trace seed metadata validation ${index}`, () => {
    if (fixture.error)
      expect(() =>
        parseTraceSeed(fixture.value, {
          label: "row",
          required: fixture.required,
        }),
      ).toThrow();
    else {
      const [messages, start] = parseTraceSeed(fixture.value, {
        label: "row",
        required: fixture.required,
      });
      expect(messages).toEqual(
        fixture.messages?.map((message) => MessageSchema.parse(message)) ??
          null,
      );
      expect(start).toBe(
        fixture.start == null ? null : TraceStartSchema.parse(fixture.start),
      );
    }
  });
for (const [index, fixture] of goldens.seeds.entries())
  it(`matches Python full trace prefix ${index}`, () => {
    const trace = new Trace({
      traceId: "synthetic",
      inputMessages: fixture.messages.map((message) =>
        MessageSchema.parse(message),
      ),
    });
    expect(seedMessages(trace, TraceStartSchema.parse(fixture.start))).toEqual(
      fixture.expected,
    );
  });
it("produces camelCase seed rows, retains structured messages and does not modify a trace", async () => {
  const trace = new Trace({
    traceId: "trace",
    inputMessages: [
      MessageSchema.parse({ role: "system", content: "System" }),
      MessageSchema.parse({
        role: "user",
        content: [{ type: "input_text", text: "Hi" }],
      }),
    ],
    outputMessages: [
      MessageSchema.parse({ role: "assistant", content: "Hello" }),
    ],
    metadata: { under_score: { raw_key: true } },
  });
  const rows = await datapointsFromTraces([trace], {
    startFrom: "last_assistant",
  });
  const row = rows[0];
  if (!row) throw new Error("Missing seed row");
  expect(row.inputs).toMatchObject({
    sourceTraceId: "trace",
    traceStartFrom: "last_assistant",
    traceSeedMessages: [
      { role: "system", content: "System" },
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      { role: "assistant", content: "Hello" },
    ],
    traceMetadata: { under_score: { raw_key: true } },
  });
  expect(parseTraceSeed(row.inputs, { label: "row" })[0]).toEqual(
    trace.messages,
  );
  expect(row.inputs).not.toHaveProperty("trace_seed_messages");
});
it("skips import failures and unseedable traces but fails when no seed rows remain", async () => {
  const failed = new Trace({ traceId: "bad", importError: "unreadable" }),
    empty = new Trace({ traceId: "empty" }),
    usable = new Trace({
      traceId: "good",
      inputMessages: [MessageSchema.parse({ role: "user", content: "Hi" })],
    });
  expect(await datapointsFromTraces([failed, empty, usable])).toHaveLength(1);
  await expect(datapointsFromTraces([failed])).rejects.toThrow(
    "failed to import",
  );
  await expect(datapointsFromTraces([])).rejects.toThrow("No traces");
  await expect(datapointsFromTraces([empty])).rejects.toThrow("seedable");
  await expect(
    datapointsFromTraces([usable], { startFrom: "last_assistant" }),
  ).rejects.toThrow("seedable");
});
class Target extends AgentTarget {
  calls: Message[][] = [];
  constructor(readonly result = new AgentResponse({ text: "Hello" })) {
    super();
  }
  override async respond(messages: Message[]) {
    this.calls.push(messages);
    return this.result;
  }
  override newInstance() {
    return new Target(this.result);
  }
}
const options = { targetAgentTimeoutMs: 1000, maxTargetRetries: 0 };
it("bootstraps only the opening user and preserves tool replay and usage counters", async () => {
  const target = new Target(
    new AgentResponse({
      output: [
        toolCallOutputItem({
          call_id: "call",
          name: "lookup",
          arguments: "{}",
          result: "found",
        }),
        textOutputItem("Hello"),
      ],
      usage: UsageSchema.parse({
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        calls: 0,
        totalCost: 0.01,
      }),
    }),
  );
  const opening = MessageSchema.parse({ role: "user", content: "Hi" });
  const [messages, usage, error] = await replaySeedContext(
    target,
    [opening, MessageSchema.parse({ role: "assistant", content: "ignored" })],
    "first_user",
    options,
  );
  expect(target.calls).toEqual([[opening]]);
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  expect(messages[1]?.tool_calls?.[0]?.id).toBe("call");
  expect(messages[2]).toMatchObject({ tool_call_id: "call", content: "found" });
  expect(usage).toMatchObject({
    calls: 1,
    pricedCalls: 1,
    totalTokens: 5,
    totalCost: 0.01,
  });
  expect(error).toBeNull();
});
it("returns a failed bootstrap's usage and structured error without synthetic target text in history", async () => {
  const target = new Target(
    new AgentResponse({
      text: "down",
      usage: UsageSchema.parse({ inputTokens: 3, calls: 0 }),
      error: { message: "down", errorType: "target_error", code: "failed" },
    }),
  );
  const opening = MessageSchema.parse({ role: "user", content: "Hi" });
  const [messages, usage, error] = await replaySeedContext(
    target,
    [opening],
    "first_user",
    options,
  );
  expect(messages).toEqual([opening]);
  expect(usage).toMatchObject({ inputTokens: 3, calls: 1 });
  expect(error).toMatchObject({
    errorStage: "target_call",
    errorCode: "failed",
    errorTurn: 1,
  });
  expect(error?.error).toContain("during trace bootstrap");
});
it("imports the last-assistant prefix without calling a caller-owned target and refuses a stateful adapter", async () => {
  const target = new Target(),
    messages = [
      MessageSchema.parse({ role: "user", content: "Hi" }),
      MessageSchema.parse({ role: "assistant", content: "Hello" }),
    ];
  expect(
    await replaySeedContext(target, messages, "last_assistant", options),
  ).toEqual([messages, null, null]);
  expect(target.calls).toHaveLength(0);
  const stateful = Object.assign(target, { historyMode: "target" });
  await expect(
    replaySeedContext(stateful, messages, "last_assistant", options),
  ).rejects.toThrow("target-owned");
  expect(() => ensureTargetCanBacktrack(stateful)).toThrow("caller-owned");
});
it("rejects empty/bootstrap-role/invalid history contracts", async () => {
  const target = new Target();
  await expect(
    replaySeedContext(target, [], "first_user", options),
  ).rejects.toThrow("at least one");
  await expect(
    replaySeedContext(
      target,
      [MessageSchema.parse({ role: "system", content: "bad" })],
      "first_user",
      options,
    ),
  ).rejects.toThrow("user opening");
  expect(() =>
    targetHistoryMode(
      Object.assign(target, {
        historyMode: "unknown",
      }) as unknown as AgentTarget,
      "invalid history",
    ),
  ).toThrow("invalid history");
});
