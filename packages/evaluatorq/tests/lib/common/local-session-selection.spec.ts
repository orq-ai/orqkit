import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSessionDocument,
  resolveSessionRef,
} from "../../../src/lib/local-sessions/selection.js";

test("session selection accepts a source-root file and rejects symlink escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-select-")),
    previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = dir;
    const root = join(dir, "sessions");
    await mkdir(root);
    const path = join(root, "rollout-good.jsonl"),
      outside = join(dir, "rollout-outside.jsonl"),
      link = join(root, "rollout-link.jsonl");
    const data = [
      {
        type: "session_meta",
        payload: { id: "test", timestamp: "2026-11-10T00:00:00Z" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    await writeFile(path, data);
    await writeFile(outside, data);
    await symlink(outside, link);
    expect((await resolveSessionRef({ source: "codex", path })).sessionId).toBe(
      "test",
    );
    expect((await loadSessionDocument({ source: "codex", path })).traceId).toBe(
      "codex:test",
    );
    const { buildSessionSnapshot, SnapshotTooLarge } = await import(
      "../../../src/lib/local-sessions/snapshot.js"
    );
    const { Snapshot } = await import(
      "../../../src/lib/trace-finder/models.js"
    );
    const frozen = await buildSessionSnapshot([
      { source: "codex", path },
      { source: "codex", path },
    ]);
    expect(frozen.nSessions).toBe(1);
    expect(
      new Snapshot(JSON.parse(frozen.data.toString())).documents[0]?.traceId,
    ).toBe("codex:test");
    await expect(
      buildSessionSnapshot([{ source: "codex", path }], { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(SnapshotTooLarge);
    await expect(
      resolveSessionRef({ source: "codex", path: link }),
    ).rejects.toThrow("not a main session file");
    await expect(
      resolveSessionRef({ source: "codex", path: outside }),
    ).rejects.toThrow("not a main session file");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
