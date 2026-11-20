import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_FRAMEWORK_LINE_BYTES } from "../../../src/lib/integrations/python-frameworks/bridge.js";
import {
  CrewAITarget,
  PydanticAITarget,
  PythonFrameworkError,
  PythonFrameworkTimeoutError,
} from "../../../src/lib/integrations/python-frameworks/index.js";

let root: string;
let executable: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "eq-python-framework-"));
  executable = join(root, "python-fixture");
  await writeFile(
    executable,
    `#!/usr/bin/env python3
import json, os, sys, time
count = 0
options = {}
for line in sys.stdin:
    request = json.loads(line)
    method, params = request["method"], request["params"]
    if method == "init":
        options = params
        if params["factory"] == "missing:factory":
            print(json.dumps({"id": request["id"], "ok": False, "error": {"type": "ImportError", "message": "Install evaluatorq and crewai into the selected Python environment"}}), flush=True)
            continue
        result = {"history_mode": "caller" if params["framework"] == "crewai" else "target", "memory_entity_id": params["memory_entity_id"]}
    elif method == "get_agent_context":
        result = {"key": "worker_" + str(os.getpid()), "display_name": "Fixture agent", "target_kind": "direct", "description": json.dumps(options), "tools": [{"name": "lookup", "parameters": {"inner_key": {"type": "string"}}, "action_type": "tool"}]}
    else:
        value = params["messages"][-1]["content"]
        if value == "hang": time.sleep(60)
        if value == "exit": sys.exit(3)
        if value == "malformed":
            print("not JSON", flush=True)
            continue
        if value == "oversize":
            sys.stdout.write("x" * (${MAX_FRAMEWORK_LINE_BYTES} + 1))
            sys.stdout.flush()
            continue
        if value == "invalid-utf8":
            os.write(1, b'"\\xff"\\n')
            continue
        if value == "error":
            print(json.dumps({"id": request["id"], "ok": False, "error": {"type": "RuntimeError", "message": "rate limited", "status_code": 429, "usage": {"input_tokens": 4, "output_tokens": 3, "total_tokens": 7, "calls": 1}}}), flush=True)
            continue
        count += 1
        result = {"output": [{"type": "output_text", "text": str(os.getpid()) + ":" + str(count), "annotations": []}, {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "lookup", "arguments": "{\\"city\\":\\"Amsterdam\\"}", "result": json.dumps(params["messages"])}], "usage": {"input_tokens": 4, "output_tokens": 3, "total_tokens": 7, "cached_tokens": 1, "total_cost": 0.02, "input_cost": 0.01, "output_cost": 0.01, "calls": 1, "priced_calls": 1}, "trace_id": "trace_1", "span_id": "span_1", "response_id": "response_1", "finish_reason": "completed"}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}, ensure_ascii=False), flush=True)
`,
  );
  await chmod(executable, 0o700);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const message = (content: string) => [{ role: "user" as const, content }];
const options = () => ({
  factory: "fixture:make_agent",
  pythonExecutable: executable,
  timeoutMs: 2000,
});
const pid = (key: string) => Number(key.replace("worker_", ""));
const isGone = (key: string) => {
  expect(() => process.kill(pid(key), 0)).toThrow();
};
const waitUntilGone = async (key: string) => {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid(key), 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Python worker survived cancellation");
};

test("validates the factory locator and timer bounds before starting a process", () => {
  expect(() => new CrewAITarget({ factory: "not-a-locator" })).toThrow(
    "factory",
  );
  for (const timeoutMs of [0, -1, Number.NaN, Infinity, 2147483648])
    expect(
      () => new CrewAITarget({ factory: "fixture:make_agent", timeoutMs }),
    ).toThrow("timeoutMs");
});

test("preserves messages, native context, tool results, usage and trace handles", async () => {
  const target = new CrewAITarget({
    ...options(),
    inputKey: "chat",
    extraInputs: { region_code: "NL" },
  });
  try {
    const context = await target.getAgentContext();
    expect(context.displayName).toBe("Fixture agent");
    expect(context.tools[0]?.parameters).toEqual({
      inner_key: { type: "string" },
    });
    expect(context.tools[0]?.actionType).toBe("tool");
    const initialization = JSON.parse(context.description ?? "{}");
    expect(initialization.target_options).toEqual({
      input_key: "chat",
      extra_inputs: { region_code: "NL" },
    });
    const transcript = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call_old",
            type: "function" as const,
            function: { name: "old", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: "prior result",
        tool_call_id: "call_old",
        name: "old",
      },
      {
        role: "user" as const,
        content: [{ type: "input_text" as const, text: "Goedemorgen 🌍" }],
      },
    ];
    const result = await target.respond(transcript);
    expect(result.traceId).toBe("trace_1");
    expect(result.spanId).toBe("span_1");
    expect(result.responseId).toBe("response_1");
    expect(result.finishReason).toBe("completed");
    expect(result.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 7,
      cachedTokens: 1,
      totalCost: 0.02,
      pricedCalls: 1,
    });
    const call = result.toolCalls[0];
    expect(call?.call_id).toBe("call_1");
    const echoed = JSON.parse(String(call?.result));
    expect(echoed[0].tool_calls[0].function.arguments).toBe("{}");
    expect(echoed[1].tool_call_id).toBe("call_old");
    expect(echoed[2].content).toEqual(transcript[2]?.content);
  } finally {
    await target.close();
  }
});

test("persists each target's state and gives clones independent workers", async () => {
  const target = new PydanticAITarget(options());
  const one = target.newInstance();
  const two = target.newInstance();
  let keys: string[] = [];
  try {
    expect(target.historyMode).toBe("target");
    expect(new CrewAITarget(options()).historyMode).toBe("caller");
    const contexts = await Promise.all(
      [target, one, two].map((item) => item.getAgentContext()),
    );
    keys = contexts.map((context) => context.key);
    expect(new Set(keys).size).toBe(3);
    const first = await one.respond(message("hello"));
    const second = await one.respond(message("again"));
    expect(first.text).toEndWith(":1");
    expect(second.text).toEndWith(":2");
    expect((await two.respond(message("other"))).text).toEndWith(":1");
    await target.cleanupMemory(contexts[0] as never, [
      one.memoryEntityId as string,
    ]);
    isGone(keys[1] as string);
    expect((await two.respond(message("still here"))).text).toEndWith(":2");
  } finally {
    await target.close();
  }
  for (const key of keys) isGone(key);
});

test("serializes calls to the same native target", async () => {
  const target = new PydanticAITarget(options());
  try {
    const results = await Promise.all([
      target.respond(message("first")),
      target.respond(message("second")),
    ]);
    expect(results.map((result) => result.text.split(":").at(-1))).toEqual([
      "1",
      "2",
    ]);
  } finally {
    await target.close();
  }
});

test("retains usage and status on native exceptions without losing the worker", async () => {
  const target = new PydanticAITarget(options());
  try {
    let caught: unknown;
    try {
      await target.respond(message("error"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      status: 429,
      usage: { inputTokens: 4, totalTokens: 7 },
    });
    expect((await target.respond(message("next"))).text).toEndWith(":1");
  } finally {
    await target.close();
  }
});

test("timeouts kill the worker and cannot silently restart its history", async () => {
  const target = new PydanticAITarget({ ...options(), timeoutMs: 500 });
  const context = await target.getAgentContext();
  try {
    await expect(target.respond(message("hang"))).rejects.toBeInstanceOf(
      PythonFrameworkTimeoutError,
    );
    await waitUntilGone(context.key);
    await expect(target.respond(message("next"))).rejects.toBeInstanceOf(
      PythonFrameworkTimeoutError,
    );
  } finally {
    await target.close();
  }
  isGone(context.key);
});

test("abort kills the worker and close rejects pending requests", async () => {
  const target = new CrewAITarget(options());
  const context = await target.getAgentContext();
  const controller = new AbortController();
  const request = target.respond(message("hang"), {
    signal: controller.signal,
  });
  await Bun.sleep(20);
  controller.abort("cancelled");
  try {
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await waitUntilGone(context.key);
  } finally {
    await target.close();
  }
  isGone(context.key);
  const second = new CrewAITarget(options());
  await second.getAgentContext();
  const pending = second.respond(message("hang"));
  const observed = pending.catch((error: unknown) => error);
  await second.close();
  expect(await observed).toMatchObject({
    message: "Python framework target is closed",
  });
});

for (const content of ["exit", "malformed", "oversize", "invalid-utf8"]) {
  test(`rejects ${content} responses and cleans up`, async () => {
    const target = new CrewAITarget(options());
    try {
      await expect(target.respond(message(content))).rejects.toBeInstanceOf(
        PythonFrameworkError,
      );
    } finally {
      await target.close();
    }
  });
}

test("missing Python and missing SDK errors name the selected runtime", async () => {
  for (const target of [
    new CrewAITarget({
      ...options(),
      pythonExecutable: join(root, "missing-python"),
    }),
    new CrewAITarget({ ...options(), factory: "missing:factory" }),
  ]) {
    try {
      await expect(target.getAgentContext()).rejects.toThrow(
        /Python|evaluatorq/,
      );
    } finally {
      await target.close();
    }
  }
});
