import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInsights } from "../../../src/lib/insights/cli.js";

test("local snapshot preview reports coverage and models without running analysis", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insights-cli-test-"));
  try {
    const path = join(directory, "snapshot.json");
    await writeFile(
      path,
      JSON.stringify({
        traces: [
          {
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
            messages: [{ role: "user", content: "complete example" }],
          },
        ],
        documents: [],
      }),
    );
    const lines: string[] = [];
    expect(
      await executeInsights(
        {
          fromSnapshot: path,
          previewInput: true,
          dimension: ["intent"],
          summaryModel: "summary-model",
          classifierModel: "classifier-model",
          embeddingModel: "embedding-model",
        },
        { print: (line) => lines.push(line) },
      ),
    ).toBe(0);
    expect(lines[0]).toContain("0 of 1 traces");
    expect(lines[1]).toContain("A run would send 1 trace");
    expect(lines[1]).toContain(
      "summary summary-model, classifier classifier-model, embedding embedding-model",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("command rejects ambiguous sources and invalid preview", async () => {
  const io = { print: (_line: string) => {} };
  await expect(
    executeInsights({ query: "q", fromSnapshot: "file" }, io),
  ).rejects.toThrow("mutually exclusive");
  await expect(executeInsights({ previewInput: true }, io)).rejects.toThrow(
    "requires --from-snapshot",
  );
  await expect(
    executeInsights({ fromSnapshot: "file", limit: 5 }, io),
  ).rejects.toThrow("cannot be combined");
  await expect(
    executeInsights({ dimension: ["intent", "intent"] }, io),
  ).rejects.toThrow("unique");
});

test("session preview searches synthetic sessions without sending them to models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insights-sessions-cli-")),
    previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = directory;
    const { mkdir } = await import("node:fs/promises");
    const root = join(directory, "sessions");
    await mkdir(root);
    const records = [
      {
        type: "session_meta",
        payload: {
          id: "session",
          timestamp: "2026-11-10T10:00:00Z",
          cwd: "/project",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-11-10T11:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "complete session request" }],
        },
      },
    ];
    await writeFile(
      join(root, "rollout-test.jsonl"),
      records.map((value) => JSON.stringify(value)).join("\n"),
    );
    const lines: string[] = [];
    const code = await executeInsights(
      {
        sessions: true,
        source: ["codex"],
        text: "session request",
        previewInput: true,
        dimension: ["intent"],
      },
      { print: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    expect(lines.some((line) => line.includes("0 of 1 traces"))).toBe(true);
    expect(
      lines.some((line) => line.includes("A run would send 1 trace")),
    ).toBe(true);
    await expect(
      executeInsights({ sessions: true, query: "q" }, { print: () => {} }),
    ).rejects.toThrow("cannot be combined");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
