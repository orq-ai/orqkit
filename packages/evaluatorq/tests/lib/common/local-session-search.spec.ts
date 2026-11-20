import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectMatches,
  searchSessions,
} from "../../../src/lib/local-sessions/search.js";

test("session search filters source, project and confirmed conversation text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-search-")),
    previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = dir;
    const root = join(dir, "sessions"),
      project = join(dir, "project");
    await mkdir(root);
    await mkdir(project);
    const write = async (id: string, text: string) =>
      writeFile(
        join(root, `rollout-${id}.jsonl`),
        [
          {
            type: "session_meta",
            payload: { id, timestamp: "2026-11-10T10:00:00Z", cwd: project },
          },
          {
            type: "response_item",
            timestamp: "2026-11-10T11:00:00Z",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      );
    await write("a", "Fix the Unicode test");
    await write("b", "Привет from another session");
    const query = {
      sources: ["codex"] as const,
      start: null,
      end: null,
      projectDir: project,
      text: "unicode",
      limit: 10,
    };
    const found = await searchSessions(query);
    expect(found.complete).toBe(true);
    expect(found.candidateFiles).toBe(2);
    expect(found.sessions.map((session) => session.sessionId)).toEqual(["a"]);
    const unicode = await searchSessions({ ...query, text: "привет" });
    expect(unicode.sessions.map((session) => session.sessionId)).toEqual(["b"]);
    expect(await projectMatches(join(project, "nested"), project)).toBe(true);
    const stopped = await searchSessions(query, { deadlineMs: 0 });
    expect(stopped.complete).toBe(false);
    expect(stopped.sessions).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("session CLI validates dates and writes a private reusable snapshot", async () => {
  const { executeSessions, sessionQuery } = await import(
    "../../../src/lib/local-sessions/cli.js"
  );
  const { Snapshot } = await import("../../../src/lib/trace-finder/models.js");
  const { readFile, stat } = await import("node:fs/promises");
  expect(() => sessionQuery({ from: "2026-02-30" })).toThrow(
    "invalid session date",
  );
  expect(() => sessionQuery({ from: "2026-11-10", to: "2026-11-09" })).toThrow(
    "first day",
  );
  const dir = await mkdtemp(join(tmpdir(), "sessions-export-")),
    previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = dir;
    const root = join(dir, "sessions");
    await mkdir(root);
    const records = [
      {
        type: "session_meta",
        payload: { id: "s", timestamp: "2026-11-10T10:00:00Z" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "complete example" }],
        },
      },
    ];
    await writeFile(
      join(root, "rollout-test.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
    const output = join(dir, "snapshot.json"),
      lines: string[] = [],
      notices: string[] = [];
    expect(
      await executeSessions(
        { source: ["codex"], json: true, export: output },
        {
          print: (value) => lines.push(value),
          warn: (value) => notices.push(value),
        },
      ),
    ).toBe(0);
    expect(JSON.parse(lines[0] ?? "[]") as unknown[]).toHaveLength(1);
    const snapshot = new Snapshot(JSON.parse(await readFile(output, "utf8")));
    expect(snapshot.documents[0]?.traceId).toBe("codex:s");
    if (process.platform !== "win32")
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(notices[0]).toContain("Wrote 1 session");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
