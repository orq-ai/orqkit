import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isOmpSessionPath,
  ompChain,
  parseOmp,
  summarizeOmp,
} from "../../../src/lib/local-sessions/omp.js";

test("OMP reader follows the active chain and preserves tool errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-reader-"));
  try {
    const path = join(dir, "session.jsonl"),
      records = [
        {
          type: "session",
          id: "s",
          cwd: "/project",
          timestamp: "2026-11-10T10:00:00Z",
          title: "Session",
        },
        {
          type: "message",
          id: "a",
          parentId: "s",
          message: { role: "user", content: "first" },
        },
        {
          type: "message",
          id: "old",
          parentId: "a",
          message: { role: "user", content: "abandoned" },
        },
        {
          type: "message",
          id: "new",
          parentId: "a",
          message: {
            role: "assistant",
            model: "m",
            provider: "p",
            usage: { totalTokens: 12 },
            content: [
              {
                type: "toolCall",
                id: "c",
                name: "shell",
                arguments: { cmd: "test" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "result",
          parentId: "new",
          timestamp: "2026-11-10T11:00:00Z",
          message: {
            role: "toolResult",
            toolCallId: "c",
            isError: true,
            content: "failed",
          },
        },
      ];
    await writeFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const summary = await summarizeOmp(path);
    expect(summary?.title).toBe("Session");
    expect(summary?.firstPrompt).toBe("first");
    expect(ompChain(records).map((record) => record.id)).toEqual([
      "s",
      "a",
      "new",
      "result",
    ]);
    if (!summary) throw new Error("missing summary");
    const parsed = await parseOmp(path, summary);
    expect(parsed.items.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(parsed.items[2]?.output).toBe("Error: failed");
    expect(parsed.model).toBe("p/m");
    expect(parsed.totalTokens).toBe(12);
    expect(isOmpSessionPath(join(dir, "project", "a.jsonl"), dir)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
