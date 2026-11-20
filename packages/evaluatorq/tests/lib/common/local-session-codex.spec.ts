import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexCallFailed,
  isCodexSessionPath,
  parseCodex,
  summarizeCodex,
} from "../../../src/lib/local-sessions/codex.js";

test("Codex reader removes injected context and retains conversation and tool failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-reader-")),
    previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = dir;
    await writeFile(
      join(dir, "session_index.jsonl"),
      `${JSON.stringify({ id: "abc", thread_name: "Example session" })}\n`,
    );
    const path = join(dir, "rollout-example.jsonl"),
      records = [
        {
          type: "session_meta",
          payload: {
            id: "abc",
            timestamp: "2026-11-10T10:00:00Z",
            cwd: "/project",
            cli_version: "1",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<environment_context> hidden" },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "fix the test" }],
          },
        },
        { type: "turn_context", payload: { model: "test-model" } },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "c1",
            name: "shell",
            arguments: '{"cmd":"test"}',
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "c1",
            output: "Exit code: 2\nfailed",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "fixed" }],
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-11-10T11:00:00Z",
          payload: {
            type: "token_count",
            info: { total_token_usage: { total_tokens: 20 } },
          },
        },
      ];
    await writeFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const summary = await summarizeCodex(path);
    expect(summary?.title).toBe("Example session");
    expect(summary?.firstPrompt).toBe("fix the test");
    expect(summary?.updatedAt.toISOString()).toBe("2026-11-10T11:00:00.000Z");
    if (!summary) throw new Error("missing summary");
    const result = await parseCodex(path, summary);
    expect(result.items.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(result.items[2]?.output).toBe("Error: Exit code: 2\nfailed");
    expect(result.model).toBe("test-model");
    expect(result.totalTokens).toBe(20);
    const { sessionDocument } = await import(
      "../../../src/lib/local-sessions/documents.js"
    );
    const { toChatMessages } = await import(
      "../../../src/lib/common/trace-document.js"
    );
    const document = sessionDocument(result);
    expect(document.traceId).toBe("codex:abc");
    expect(document.totalTokens).toBe(20);
    expect(document.toolNames).toEqual(["shell"]);
    expect(JSON.stringify(toChatMessages(document))).toContain("fix the test");
    expect(codexCallFailed("Exit code: 0\nok")).toBe(false);
    expect(
      isCodexSessionPath(join(dir, "2026", "11", "10", "rollout-a.jsonl"), dir),
    ).toBe(true);
    expect(isCodexSessionPath(join(dir, "sub", "rollout-a.jsonl"), dir)).toBe(
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
