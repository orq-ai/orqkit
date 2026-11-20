import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeClaudeBranch,
  isClaudeSessionPath,
  parseClaude,
  summarizeClaude,
} from "../../../src/lib/local-sessions/claude.js";

test("Claude reader follows the active prompt branch and retains tool failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-reader-"));
  try {
    const path = join(dir, "session.jsonl"),
      records = [
        {
          uuid: "u1",
          type: "user",
          sessionId: "id",
          cwd: "/project",
          timestamp: "2026-11-10T10:00:00Z",
          message: { content: "first" },
        },
        {
          uuid: "old",
          parentUuid: "u1",
          type: "user",
          message: { content: "abandoned" },
        },
        {
          uuid: "new",
          parentUuid: "u1",
          type: "user",
          message: { content: "active" },
        },
        {
          uuid: "a",
          parentUuid: "new",
          type: "assistant",
          message: {
            id: "m",
            model: "test-model",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              {
                type: "tool_use",
                id: "c",
                name: "shell",
                input: { cmd: "test" },
              },
            ],
          },
        },
        {
          uuid: "r",
          parentUuid: "a",
          type: "user",
          timestamp: "2026-11-10T11:00:00Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "c",
                content: "failed",
                is_error: true,
              },
            ],
          },
        },
        { type: "last-prompt", leafUuid: "r" },
        { type: "custom-title", customTitle: "Title" },
      ];
    await writeFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const summary = await summarizeClaude(path);
    expect(summary?.title).toBe("Title");
    expect(summary?.firstPrompt).toBe("first");
    expect(activeClaudeBranch(records).map((record) => record.uuid)).toEqual([
      "u1",
      "new",
      "a",
      "r",
    ]);
    if (!summary) throw new Error("missing summary");
    const parsed = await parseClaude(path, summary);
    expect(parsed.items.map((item) => item.type)).toEqual([
      "message",
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(parsed.items[3]?.output).toBe("Error: failed");
    expect(parsed.totalTokens).toBe(15);
    expect(parsed.model).toBe("test-model");
    expect(
      isClaudeSessionPath(join(dir, "project", "session.jsonl"), dir),
    ).toBe(true);
    expect(
      isClaudeSessionPath(
        join(dir, "project", "subagents", "session.jsonl"),
        dir,
      ),
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
