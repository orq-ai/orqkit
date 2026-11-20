import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OpenAI from "openai";

import {
  type AgentInstructionsClient,
  applyEdits,
  applyRecommendations,
  collectRecommendations,
  parseEdits,
} from "../../../src/lib/common/apply.js";
import {
  combineConfirm,
  fanOut,
  normalizeToList,
} from "../../../src/lib/common/async-utils.js";
import {
  classifyFinishReason,
  isContentFilterError,
  regenerateOnContentFilter,
} from "../../../src/lib/common/content-filter.js";
import * as fileLocks from "../../../src/lib/common/file-lock.js";
import { withFileLock } from "../../../src/lib/common/file-lock.js";
import {
  composeRunHooks,
  requireHooksLike,
} from "../../../src/lib/common/hook-compose.js";
import { pairIndicesByKey } from "../../../src/lib/common/matching.js";
import { resolveDatapointParallelism } from "../../../src/lib/common/parallelism.js";
import { writePrivateAtomic } from "../../../src/lib/common/private-files.js";
import {
  applyCacheBreakpoints,
  cachingApplies,
  markResponsesInput,
} from "../../../src/lib/common/prompt-cache.js";
import {
  RecommendationConfigBaseSchema,
  resolveRecommendations,
} from "../../../src/lib/common/recommendations.js";
import {
  checkReplayVersion,
  loadRunPayload,
  ReplayError,
  resolveRunPath,
} from "../../../src/lib/common/replay.js";
import {
  failIfRunning,
  iterReportFiles,
  listManifests,
  listRunRecords,
  ManifestWriter,
  readManifest,
  startManifest,
  summaryIsCurrent,
  updateManifest,
} from "../../../src/lib/common/run-manifest.js";
import {
  delimit,
  pythonSplit,
  pythonStrip,
  xmlEscape,
} from "../../../src/lib/common/sanitize.js";
import {
  callTargetWithRetry,
  classifyErrorType,
  closeTarget,
  extractStatusCode,
  NonRetryableTargetError,
  type RetryTarget,
} from "../../../src/lib/common/target-call.js";
import { unifiedDiff } from "../../../src/lib/common/unified-diff.js";
import {
  AgentResponse,
  ManifestStatus,
  MessageSchema,
  RUN_SUMMARY_VERSION,
} from "../../../src/lib/contracts.js";
import {
  messagesToResponsesInput,
  responsesFunctionCallItemId,
} from "../../../src/lib/integrations/openresponses/input-items.js";

const directories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "evaluatorq-common-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const user = (content: string) =>
  MessageSchema.parse({ role: "user", content });

describe("small helpers", () => {
  test("pairIndicesByKey consumes repeats in order", () => {
    expect(
      pairIndicesByKey(["a", "b", "a", "c"], ["a", "x", "a"], (v) => v),
    ).toEqual({
      matched: [
        [0, 0],
        [2, 2],
      ],
      aOnly: [1, 3],
      bOnly: [1],
    });
  });

  test("resolveDatapointParallelism defaults to ten", () => {
    expect(
      resolveDatapointParallelism(undefined, undefined, { caller: "t" }),
    ).toBe(10);
  });

  test("recommendation config is strict and fills defaults", () => {
    expect(RecommendationConfigBaseSchema.parse({})).toEqual({
      maxSuggestions: 3,
      maxTokens: 800,
    });
    expect(() => RecommendationConfigBaseSchema.parse({ nope: 1 })).toThrow();
    const fallback = { maxSuggestions: 3, maxTokens: 800 };
    expect(resolveRecommendations(true, () => fallback)).toEqual(fallback);
  });

  test("delimit escapes only the closing or opening of its own tag", () => {
    expect(delimit("hi")).toBe("<data>hi</data>");
    expect(delimit("a </data> b")).toBe("<data>a &lt;/data&gt; b</data>");
    expect(delimit("<DATA>x")).toBe("<data>&lt;data&gt;x</data>");
    expect(delimit("< / data >")).toBe("<data>&lt; / data &gt;</data>");
    expect(delimit("<dataset>")).toBe("<data><dataset></data>");
    expect(delimit("<DATA>x", { tag: "note" })).toBe("<note><DATA>x</note>");
    expect(() => delimit("x", { tag: "1bad" })).toThrow("Invalid tag name");
    expect(xmlEscape("a<b>&\"'")).toBe("a&lt;b&gt;&amp;\"'");
  });

  test("Python whitespace differs from trim", () => {
    expect(pythonStrip("\u0085 a\u001c")).toBe("a");
    expect(pythonStrip("﻿a")).toBe("﻿a");
    expect(pythonSplit(" a b\n")).toEqual(["a", "b"]);
  });

  test("normalizeToList wraps a single hook", () => {
    const hook = { onConfirm: async () => true };
    expect(normalizeToList(hook)).toEqual([hook]);
    expect(normalizeToList(null)).toEqual([]);
  });

  test("fanOut calls each child and combineConfirm needs every yes", async () => {
    const seen: string[] = [];
    await fanOut(
      [
        { onStage: async (v: string) => seen.push(`a${v}`) },
        { onStage: (v: string) => seen.push(`b${v}`) },
      ],
      "onStage",
      "1",
    );
    expect(seen.sort()).toEqual(["a1", "b1"]);
    expect(
      await combineConfirm([
        { onConfirm: async () => true },
        { onConfirm: async () => false },
      ]),
    ).toBe(false);
  });

  test("composeRunHooks validates before minting a manifest", () => {
    let minted = 0;
    const options = {
      methodNames: ["onConfirm"],
      composite: (children: unknown[]) => children,
      defaultHooks: () => "default",
      manifest: () => {
        minted += 1;
        return "writer";
      },
      manifestHook: (writer: string) => `hook:${writer}`,
    };
    expect(() => composeRunHooks([{}], options)).toThrow(TypeError);
    expect(minted).toBe(0);
    expect(composeRunHooks(undefined, options)).toEqual({
      hooks: ["hook:writer", "default"],
      writer: "writer",
    });
    expect(() => requireHooksLike({ onConfirm: () => true })).not.toThrow();
  });

  test("content filter is read from the structured code", async () => {
    expect(classifyFinishReason("content_filter")).toBe("content_filter");
    expect(classifyFinishReason("stop")).toBeNull();
    expect(isContentFilterError({ body: { code: "content_filter" } })).toBe(
      true,
    );
    expect(isContentFilterError(new Error("content_filter"))).toBe(false);
    let calls = 0;
    const response = await regenerateOnContentFilter(
      async () => {
        calls += 1;
        return {
          choices: [{ finish_reason: calls < 2 ? "content_filter" : "stop" }],
        };
      },
      { maxAttempts: 3 },
    );
    expect(calls).toBe(2);
    expect(response.choices[0]?.finish_reason).toBe("stop");
  });
});

describe("files", () => {
  test("writePrivateAtomic writes 0600 in a 0700 directory", async () => {
    const path = join(scratch(), "private", "file.json");
    await writePrivateAtomic(path, "{}");
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  test("withFileLock serialises callers and releases after a throw", async () => {
    const path = join(scratch(), "x.lock");
    const order: string[] = [];
    await Promise.all(
      ["a", "b"].map((name) =>
        withFileLock(path, async () => {
          order.push(`${name}-in`);
          await sleep(10);
          order.push(`${name}-out`);
        }),
      ),
    );
    expect(order).toEqual(["a-in", "a-out", "b-in", "b-out"]);
    await expect(
      withFileLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withFileLock(path, async () => "free")).toBe("free");
  });

  test("withFileLock replaces a holder that died", async () => {
    const path = join(scratch(), "x.lock");
    writeFileSync(`${path}.held`, "999999");
    expect(await withFileLock(path, async () => "taken")).toBe("taken");
  });
});

describe("unifiedDiff", () => {
  const files = { fromFile: "a", toFile: "b" };

  test("matches the difflib hunk format", () => {
    expect(unifiedDiff("x\ny\nz\n", "x\nY\nz\n", files)).toBe(
      "--- a\n+++ b\n@@ -1,3 +1,3 @@\n x\n-y\n+Y\n z\n",
    );
  });

  test("no change gives no output", () => {
    expect(unifiedDiff("x\n", "x\n", files)).toBe("");
  });

  test("an insert into empty text uses a zero range", () => {
    expect(unifiedDiff("", "n\n", files)).toBe(
      "--- a\n+++ b\n@@ -0,0 +1 @@\n+n\n",
    );
  });
});

describe("applyRecommendations", () => {
  const client = (replies: string[]) => {
    const prompts: unknown[] = [];
    return {
      prompts,
      llm: {
        chat: {
          completions: {
            create: async (params: unknown) => {
              prompts.push(params);
              return {
                choices: [{ message: { content: replies.shift() ?? "" } }],
              };
            },
          },
        },
      } as unknown as OpenAI,
    };
  };
  const orq = (instructions: string) => {
    const updates: Array<[unknown, string]> = [];
    const value: AgentInstructionsClient = {
      agents: {
        retrieve: async () => ({ instructions }),
        update: async (body, key) => {
          updates.push([body, key]);
          return { version: "1.1.0" };
        },
      },
    };
    return { value, updates };
  };

  test("collect strips, dedupes and skips applied", () => {
    expect(
      collectRecommendations(
        ["  a ", { recommendations: ["b", "a", ""] }],
        20,
        ["b "],
      ),
    ).toEqual(["a"]);
  });

  test("applyEdits refuses ambiguity and tolerates whitespace", () => {
    expect(applyEdits("a a", [{ find: "a", replace: "b" }])).toBeNull();
    expect(applyEdits("one  two", [{ find: "one two", replace: "$1" }])).toBe(
      "$1",
    );
    expect(applyEdits("x", [{ find: "nope", replace: "b" }])).toBeNull();
  });

  test("parseEdits rejects anything off-contract", () => {
    expect(parseEdits('{"edits":[{"find":"a","replace":"b"}]}')).toEqual([
      { find: "a", replace: "b" },
    ]);
    expect(parseEdits('{"edits":[]}')).toBeNull();
    expect(parseEdits('{"edits":[{"find":"","replace":"b"}]}')).toBeNull();
    expect(parseEdits("[1]")).toBeNull();
  });

  test("previews by default and never writes", async () => {
    const { llm } = client([
      '{"edits":[{"find":"Be nice.","replace":"Be kind."}]}',
    ]);
    const { value, updates } = orq("Be nice.\n");
    const result = await applyRecommendations(["fix"], "k", value, llm, "m");
    expect(result.newInstructions).toBe("Be kind.");
    expect(result.applied).toBe(false);
    expect(result.diff).toContain("-Be nice.");
    expect(updates).toEqual([]);
  });

  test("falls back to a rewrite and writes a minor version", async () => {
    const { llm, prompts } = client([
      '{"edits":[{"find":"absent","replace":"b"}]}',
      '{"instructions":"Rewritten."}',
    ]);
    const { value, updates } = orq("Be nice.");
    const result = await applyRecommendations(["fix"], "k", value, llm, "m", {
      apply: true,
    });
    expect(prompts).toHaveLength(2);
    expect(result).toMatchObject({
      newInstructions: "Rewritten.",
      applied: true,
      newVersion: "1.1.0",
    });
    expect(updates).toEqual([
      [
        {
          instructions: "Rewritten.",
          versionIncrement: "minor",
          versionDescription: "Applied 1 remediation recommendation(s)",
        },
        "k",
      ],
    ]);
  });

  test("an unusable merge reports failure instead of writing", async () => {
    const { llm } = client(["nope", "nope"]);
    const { value, updates } = orq("Be nice.");
    const result = await applyRecommendations(["fix"], "k", value, llm, "m", {
      apply: true,
    });
    expect(result).toMatchObject({
      mergeFailed: true,
      applied: false,
      newInstructions: "Be nice.",
    });
    expect(updates).toEqual([]);
  });
});

describe("target call", () => {
  const options = { targetAgentTimeoutMs: 1000, maxTargetRetries: 2 };
  const target = (
    respond: () => Promise<unknown>,
    extras: Partial<RetryTarget> = {},
  ): RetryTarget => ({ respond, ...extras });

  test("classifies raw errors like Python", () => {
    expect(classifyErrorType("got 429")).toBe("rate_limit");
    expect(classifyErrorType("x4290")).toBe("unknown");
    expect(classifyErrorType("Status 503")).toBe("server_error");
    expect(classifyErrorType("")).toBeNull();
    expect(classifyErrorType("x", { existingType: "mine" })).toBe("mine");
  });

  test("status comes from the response, the chain, then the text", () => {
    expect(extractStatusCode({ response: { status: 503 }, status: 404 })).toBe(
      503,
    );
    expect(extractStatusCode(new Error("x", { cause: { status: 418 } }))).toBe(
      418,
    );
    expect(extractStatusCode(new Error("HTTP 502"))).toBe(502);
    expect(extractStatusCode(new Error("HTTP 700"))).toBeNull();
  });

  test("a plain string return is wrapped", async () => {
    const result = await callTargetWithRetry(
      target(async () => "hello"),
      [user("q")],
      options,
    );
    expect(result.succeeded).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.response.output).toHaveLength(1);
    expect(result.errorPayload().error).toBeNull();
  });

  test("retries a returned error marker up to the limit", async () => {
    let calls = 0;
    const result = await callTargetWithRetry(
      target(async () => {
        calls += 1;
        return new AgentResponse({
          text: "x",
          error: { message: "bad", errorType: "server_error", code: null },
        });
      }),
      [user("q")],
      options,
    );
    expect(calls).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.errorPayload({ context: " on turn 2/5", turn: 2 })).toEqual({
      error: "Target agent failed after 3 attempt(s) on turn 2/5: bad",
      errorType: "server_error",
      errorStage: "target_call",
      errorCode: "target_error",
      errorTurn: 2,
      errorDetails: {
        responseErrorType: "server_error",
        rawMessage: "bad",
        attempts: 3,
      },
    });
  });

  test("a 4xx stops after one attempt, a 429 keeps retrying", async () => {
    const failing = (status: number) => {
      let calls = 0;
      return {
        calls: () => calls,
        value: target(async () => {
          calls += 1;
          throw Object.assign(new Error("nope"), { status });
        }),
      };
    };
    const forbidden = failing(403);
    const denied = await callTargetWithRetry(forbidden.value, [], options);
    expect(forbidden.calls()).toBe(1);
    expect(denied.attempts).toBe(1);
    expect(denied.error?.code).toBe("target_error");
    const limited = failing(429);
    await callTargetWithRetry(limited.value, [], options);
    expect(limited.calls()).toBe(3);
  });

  test("a non-retryable error stops at once", async () => {
    let calls = 0;
    class Missing extends NonRetryableTargetError {}
    const result = await callTargetWithRetry(
      target(async () => {
        calls += 1;
        throw new Missing("binary not found");
      }),
      [],
      options,
    );
    expect(calls).toBe(1);
    expect(result.errorDetails?.exceptionType).toBe("Missing");
  });

  test("a hung call times out, is signalled and retried", async () => {
    const signals: AbortSignal[] = [];
    const result = await callTargetWithRetry(
      {
        respond: (_messages, respondOptions) => {
          signals.push(respondOptions?.signal as AbortSignal);
          return new Promise(() => undefined);
        },
      },
      [],
      { targetAgentTimeoutMs: 10, maxTargetRetries: 1 },
    );
    expect(result.attempts).toBe(2);
    expect(result.error).toMatchObject({
      errorType: "timeout",
      code: "target.timeout",
    });
    expect(result.errorDetails).toEqual({ timeoutMs: 10, attempts: 2 });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  test("a target managing its own timeout gets no timer", async () => {
    const result = await callTargetWithRetry(
      target(
        async () => {
          await sleep(30);
          return "late";
        },
        { managesOwnTimeout: true },
      ),
      [],
      { targetAgentTimeoutMs: 5, maxTargetRetries: 0 },
    );
    expect(result.succeeded).toBe(true);
  });

  test("an abort propagates instead of counting as a failure", async () => {
    await expect(
      callTargetWithRetry(
        target(async () => {
          throw Object.assign(new Error("stop"), { name: "AbortError" });
        }),
        [],
        options,
      ),
    ).rejects.toThrow("stop");
  });

  test("onAttempt wraps each attempt and sees the response", async () => {
    const seen: unknown[] = [];
    await callTargetWithRetry(
      target(async () => "ok"),
      [],
      {
        ...options,
        onAttempt: async (attempt, run) => run(`span-${attempt}`),
        onAttemptResponse: (context) => seen.push(context),
      },
    );
    expect(seen).toEqual(["span-0"]);
  });

  test("closeTarget never throws", async () => {
    await closeTarget({
      close: async () => {
        throw new Error("x");
      },
    });
    await closeTarget({});
    await closeTarget(null);
  });
});

describe("prompt cache and Responses input", () => {
  const big = "w".repeat(4096);

  test("only routed Anthropic-capable targets are marked", () => {
    const routed = { baseURL: "https://my.orq.ai/v3/router" };
    expect(cachingApplies(routed, "anthropic/claude-x")).toBe(true);
    expect(cachingApplies(routed, "agent/foo")).toBe(true);
    expect(cachingApplies(routed, "openai/gpt-5.4-nano")).toBe(false);
    expect(cachingApplies({ baseURL: "https://x.test" }, "claude-x")).toBe(
      false,
    );
    expect(cachingApplies(null, "claude-x")).toBe(false);
  });

  test("marks the system message and prefix end, skipping the tail", () => {
    const messages = [
      { role: "system", content: big },
      { role: "user", content: "stable" },
      { role: "user", content: "tail" },
    ];
    const out = applyCacheBreakpoints(messages, { volatileTail: 1 });
    const marked = out.map((m) => Array.isArray(m.content));
    expect(marked).toEqual([true, true, false]);
    expect(messages[0]?.content).toBe(big);
  });

  test("below the minimum nothing is marked; a negative tail throws", () => {
    const small = [{ role: "user", content: "s" }];
    expect(applyCacheBreakpoints(small, { volatileTail: 0 })).toEqual(small);
    expect(() => applyCacheBreakpoints(small, { volatileTail: -1 })).toThrow(
      RangeError,
    );
  });

  test("Responses marker lands on the last part", () => {
    expect(
      markResponsesInput([{ role: "user", content: big }], {
        volatileItems: 0,
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: big,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("tool turns become function items", () => {
    const messages = [
      {
        role: "assistant",
        content: "with",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: '{"a":1}' },
            item_id: "fc_1",
          },
        ],
      },
      { role: "tool", content: "r", tool_call_id: "c1" },
      { role: "tool", content: "orphan" },
      { role: "user", content: null },
    ].map((m) => MessageSchema.parse(m));
    expect(messagesToResponsesInput(messages)).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "with" }] },
      {
        type: "function_call",
        call_id: "c1",
        name: "f",
        arguments: '{"a":1}',
        id: "fc_1",
      },
      { type: "function_call_output", call_id: "c1", output: "r" },
      { role: "user", content: "" },
    ]);
    expect(responsesFunctionCallItemId("toolu_1")).toBeNull();
  });
});

describe("run manifest", () => {
  const start = (runsDir: string, runId = "run-1") =>
    startManifest({ runId, surface: "sim", runName: "n", runsDir });
  const manifestPath = (runsDir: string, runId = "run-1") =>
    join(runsDir, ".manifests", `${runId}.json`);

  test("a run walks through its stages to completed", async () => {
    const runsDir = scratch();
    const writer = await start(runsDir);
    await writer.startStage("a");
    await writer.startStage("b");
    await writer.stageProgress("b", 1, 2);
    await writer.complete("/r.json", { totalResults: 2 });
    const stored = await readManifest(runsDir, "run-1");
    expect(stored?.status).toBe(ManifestStatus.COMPLETED);
    expect(stored?.stages.map((s) => [s.name, s.status])).toEqual([
      ["a", ManifestStatus.COMPLETED],
      ["b", ManifestStatus.COMPLETED],
    ]);
    expect(stored?.reportPath).toBe("/r.json");
    expect(stored?.summaryVersion).toBe(RUN_SUMMARY_VERSION);
    expect(summaryIsCurrent(stored as never)).toBe(true);
  });

  test("the first terminal status wins across writers", async () => {
    const runsDir = scratch();
    const writer = await start(runsDir);
    expect(await failIfRunning(manifestPath(runsDir), "crashed", "x")).toBe(
      true,
    );
    await writer.complete("/r.json");
    const stored = await readManifest(runsDir, "run-1");
    expect(stored?.status).toBe(ManifestStatus.ERROR);
    expect(stored?.error).toBe("crashed");
    expect(writer.manifest.status).toBe(ManifestStatus.ERROR);
    expect(await failIfRunning(manifestPath(runsDir), "again")).toBe(false);
  });

  test("a flush keeps fields another writer changed", async () => {
    const runsDir = scratch();
    const writer = await start(runsDir);
    await updateManifest(manifestPath(runsDir), (manifest) => {
      manifest.parallelism = 7;
    });
    await writer.startStage("a");
    const stored = await readManifest(runsDir, "run-1");
    expect(stored?.parallelism).toBe(7);
    expect(stored?.stage).toBe("a");
  });

  test("concurrent transitions all reach the disk", async () => {
    const runsDir = scratch();
    const writer = await start(runsDir);
    await Promise.all(
      ["a", "b", "c"].map((target) => writer.startStage("s", { target })),
    );
    const stored = await readManifest(runsDir, "run-1");
    expect(stored?.stages.map((s) => s.target).sort()).toEqual(["a", "b", "c"]);
  });

  test("a target stage is not closed by a targetless end", async () => {
    const runsDir = scratch();
    const writer = await start(runsDir);
    await writer.startStage("s", { target: "x" });
    await writer.endStage("s");
    expect(writer.manifest.stages[0]?.endedAt).toBeNull();
    await writer.endStage("s", { target: "x", error: "boom" });
    expect(writer.manifest.stages[0]?.status).toBe(ManifestStatus.ERROR);
  });

  test("progress is throttled and invalid counts are ignored", async () => {
    const runsDir = scratch();
    let now = 0;
    const base = await start(runsDir);
    const writer = new ManifestWriter(base.manifest, base.path, {
      clock: () => now,
    });
    await writer.startStage("s");
    await writer.stageProgress("s", 1, 10);
    now = 500;
    await writer.stageProgress("s", 2, 10);
    expect((await readManifest(runsDir, "run-1"))?.stages[0]?.completed).toBe(
      1,
    );
    now = 1000;
    await writer.stageProgress("s", 3, 10);
    expect((await readManifest(runsDir, "run-1"))?.stages[0]?.completed).toBe(
      3,
    );
    await writer.stageProgress("s", 11, 10);
    expect(writer.manifest.stages[0]?.completed).toBe(3);
  });

  test("failure closes open stages and leaves finished ones", async () => {
    const runsDir = scratch();
    const writer = await start(runsDir);
    await writer.startStage("a");
    await writer.endStage("a");
    await writer.startStage("b");
    await writer.fail("boom");
    expect(writer.manifest.stages.map((s) => s.status)).toEqual([
      ManifestStatus.COMPLETED,
      ManifestStatus.ERROR,
    ]);
    await writer.cancel();
    expect(writer.manifest.status).toBe(ManifestStatus.ERROR);
  });

  test("a bad manifest is skipped and stage artifacts are not reports", async () => {
    const runsDir = scratch();
    await start(runsDir);
    writeFileSync(join(runsDir, ".manifests", "bad.json"), "{");
    writeFileSync(join(runsDir, "01_stage.json"), "{}");
    writeFileSync(join(runsDir, "report.json"), "{}");
    expect(await listManifests(runsDir)).toHaveLength(1);
    expect(await iterReportFiles(runsDir)).toEqual([
      join(runsDir, "report.json"),
    ]);
    expect(await listManifests(join(runsDir, "absent"))).toEqual([]);
  });

  test("records dedupe covered reports and demote stale summaries", async () => {
    const runsDir = scratch();
    const covered = join(runsDir, "covered.json");
    const stale = join(runsDir, "stale.json");
    const legacy = join(runsDir, "legacy.json");
    for (const path of [covered, stale, legacy]) {
      writeFileSync(path, "{}");
    }
    await (await start(runsDir, "a")).complete(covered, { totalResults: 1 });
    await (await start(runsDir, "b")).complete(stale);
    const records = await listRunRecords(runsDir);
    expect(records).toHaveLength(3);
    expect(
      records
        .filter((r) => r.manifest === null)
        .map((r) => r.reportPath)
        .sort(),
    ).toEqual([legacy, stale].sort());
    expect(records.find((r) => r.reportPath === covered)?.manifest?.runId).toBe(
      "a",
    );
  });
});

describe("replay", () => {
  const surface = { surface: "sim" };

  test("rejects a newer format", () => {
    expect(() =>
      checkReplayVersion({ replay_version: 2 }, "/x/a.json", surface),
    ).toThrow("replay format v2");
    expect(() => checkReplayVersion({}, "/x/a.json", surface)).not.toThrow();
  });

  test("resolves latest, names, ids and rejects ambiguity", async () => {
    const runsDir = scratch();
    const older = join(runsDir, "nightly_1.json");
    const newer = join(runsDir, "nightly_2.json");
    writeFileSync(older, "{}");
    await sleep(15);
    writeFileSync(newer, '{"a":1}');
    expect(await resolveRunPath("latest", runsDir, surface)).toBe(newer);
    expect(await resolveRunPath("nightly", runsDir, surface)).toBe(newer);
    expect(await resolveRunPath("nightly_1", runsDir, surface)).toBe(older);
    await (
      await startManifest({
        runId: "abcdefgh11",
        surface: "sim",
        runName: "n",
        runsDir,
      })
    ).complete(older);
    expect(await resolveRunPath("abcdefgh11", runsDir, surface)).toBe(older);
    expect(await resolveRunPath("abcdefgh", runsDir, surface)).toBe(older);
    await (
      await startManifest({
        runId: "abcdefgh22",
        surface: "sim",
        runName: "n",
        runsDir,
      })
    ).complete(newer);
    await expect(resolveRunPath("abcdefgh", runsDir, surface)).rejects.toThrow(
      "ambiguous",
    );
    await expect(resolveRunPath("  ", runsDir, surface)).rejects.toThrow(
      ReplayError,
    );
    await expect(resolveRunPath("zzz", runsDir, surface)).rejects.toThrow(
      "Recent runs: nightly_2.json, nightly_1.json.",
    );
  });

  test("loads objects only", async () => {
    const runsDir = scratch();
    writeFileSync(join(runsDir, "list.json"), "[1]");
    writeFileSync(join(runsDir, "bad.json"), "{");
    writeFileSync(join(runsDir, "ok.json"), '{"a":1}');
    expect((await loadRunPayload("ok", runsDir, surface)).payload).toEqual({
      a: 1,
    });
    await expect(loadRunPayload("list", runsDir, surface)).rejects.toThrow(
      "does not contain a run object",
    );
    await expect(loadRunPayload("bad", runsDir, surface)).rejects.toThrow(
      "is not valid JSON",
    );
  });
});

test("a manifest lock failure never writes without exclusive ownership", async () => {
  const runsDir = scratch();
  const lock = spyOn(fileLocks, "withFileLock").mockRejectedValue(
    new fileLocks.FileLockTimeoutError("held by another owner"),
  );
  try {
    await expect(
      startManifest({
        runId: "blocked",
        surface: "sim",
        runName: "blocked",
        runsDir,
      }),
    ).rejects.toThrow("held by another owner");
    expect(await listManifests(runsDir)).toEqual([]);
  } finally {
    lock.mockRestore();
  }
});
