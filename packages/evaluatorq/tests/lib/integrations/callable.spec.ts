import { expect, it, spyOn } from "bun:test";

import {
  AgentContextSchema,
  AgentResponse,
  MessageSchema,
  UsageSchema,
} from "../../../src/lib/contracts.js";
import { CallableTarget } from "../../../src/lib/integrations/callable/index.js";
import { fromChatCompletions } from "../../../src/lib/integrations/simulation/adapters.js";

const messages = [
  MessageSchema.parse({ role: "user", content: "hi" }),
  MessageSchema.parse({
    role: "tool",
    content: "tool value",
    tool_call_id: "call",
  }),
];
it("forwards the full typed transcript to synchronous and asynchronous callbacks", async () => {
  for (const fn of [
    (rows: typeof messages) => rows.map((m) => m.role).join(","),
    async (rows: typeof messages) => rows.map((m) => m.role).join(","),
  ]) {
    const response = await new CallableTarget(fn).respond(messages);
    expect(response.text).toBe("user,tool");
    expect(response.usage).toBeNull();
  }
});
it("retains structured tool output, errors, traces and usage without calling usageFn", async () => {
  const response = new AgentResponse({
    text: "done",
    traceId: "trace",
    usage: UsageSchema.parse({ inputTokens: 3, totalTokens: 3 }),
  });
  let usageCalled = false;
  const target = new CallableTarget(() => response, {
    usageFn: () => {
      usageCalled = true;
      return null;
    },
  });
  expect(await target.respond(messages)).toBe(response);
  expect(usageCalled).toBe(false);
});
it("attaches usage from a string callback and ignores a failed usage extractor", async () => {
  const usage = UsageSchema.parse({ totalTokens: 5 });
  const target = new CallableTarget(() => "done", {
    usageFn: (rows, text) => {
      expect(rows).toBe(messages);
      expect(text).toBe("done");
      return usage;
    },
  });
  expect((await target.respond(messages)).usage).toEqual(usage);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      (
        await new CallableTarget(() => "done", {
          usageFn: () => {
            throw new Error("missing");
          },
        }).respond(messages)
      ).usage,
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});
it("resets shared callable state on clone and retains supplied context", async () => {
  let state = 2;
  const context = AgentContextSchema.parse({
    key: "custom",
    tools: [{ name: "lookup" }],
  });
  const target = new CallableTarget(() => String(++state), {
    resetFn: () => {
      state = 0;
    },
    agentContext: context,
  });
  expect(await target.getAgentContext()).toBe(context);
  const clone = target.newInstance();
  expect(clone).not.toBe(target);
  expect((await clone.respond(messages)).text).toBe("1");
  expect(await clone.getAgentContext()).toBe(context);
});
it("preserves cancellation and wraps other exceptions with their cause", async () => {
  const error = Object.assign(new Error("cancel"), { name: "AbortError" });
  await expect(
    new CallableTarget(() => {
      throw error;
    }).respond(messages),
  ).rejects.toBe(error);
  const cause = Object.assign(new Error("bad request"), { status: 400 });
  try {
    await new CallableTarget(() => {
      throw cause;
    }).respond(messages);
    throw new Error("expected failure");
  } catch (error) {
    expect((error as Error).cause).toBe(cause);
  }
});
it("represents empty output without fabricated usage", async () => {
  expect((await new CallableTarget(() => null).respond(messages)).text).toBe(
    "",
  );
});
it("retains AgentResponse through the chat-completions convenience adapter", async () => {
  const response = new AgentResponse({
    text: "done",
    usage: UsageSchema.parse({ totalTokens: 3 }),
  });
  const callback = fromChatCompletions(() => response);
  expect(await callback([{ role: "user", content: "hi" }])).toBe(response);
});
