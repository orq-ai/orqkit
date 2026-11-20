import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSession,
  readHead,
  readRecords,
  readTail,
  summarizeSession,
} from "../../../src/lib/local-sessions/jsonl.js";

test("JSONL readers retain complete objects and tolerate malformed and partial lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-jsonl-"));
  try {
    const path = join(directory, "session.jsonl"),
      first = '{"id":1}\n',
      middle = 'bad\n[1,2]\n{"id":2}\n',
      partial = '{"id":';
    await writeFile(path, first + middle + partial);
    expect(await readRecords(path)).toEqual({
      records: [{ id: 1 }, { id: 2 }],
      skipped: 3,
    });
    expect(await readHead(path, Buffer.byteLength(first) + 4)).toEqual([
      { id: 1 },
    ]);
    expect(
      await readTail(
        path,
        Buffer.byteLength('{"id":2}\n') + Buffer.byteLength(partial) + 1,
      ),
    ).toEqual([{ id: 2 }]);
    await writeFile(path, '{"id":3}');
    expect(await readRecords(path)).toEqual({
      records: [{ id: 3 }],
      skipped: 0,
    });
    expect(await readHead(path, 100)).toEqual([{ id: 3 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session summaries use bounded metadata and do not expose parse error contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-summary-"));
  try {
    const path = join(directory, "sample.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({ timestamp: "2026-11-10T12:00:00Z", payload: "complete" })}\n`,
    );
    const summary = await summarizeSession(path, () => ({
      source: "codex",
      sessionId: "id",
      title: "a".repeat(250),
      projectDir: "p",
      started: "2026-11-10T11:00:00Z",
      firstPrompt: "  hello  ",
      agentVersion: "1",
    }));
    expect(summary?.title).toHaveLength(200);
    expect(summary?.firstPrompt).toBe("hello");
    expect(summary?.updatedAt.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    if (!summary) throw new Error("missing summary");
    const parsed = await parseSession(path, summary, (records) => ({
      items: records,
      model: "m",
      totalTokens: 2,
    }));
    expect(parsed.items).toHaveLength(1);
    await expect(
      parseSession(path, summary, () => {
        throw new Error("private content");
      }),
    ).rejects.toThrow("unreadable session (Error)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
