import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { READERS } from "../../../src/lib/local-sessions/readers.js";
import {
  clearSummaryCache,
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

test("session search skips disappearing files and propagates unexpected reader errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-search-race-")),
    previous = process.env.CODEX_HOME,
    summarize = READERS.codex.summarize,
    warning = spyOn(console, "warn").mockImplementation(() => {});
  const root = join(dir, "sessions"),
    path = join(root, "rollout-race.jsonl"),
    records = [
      { type: "session_meta", payload: { id: "race" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "needle" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
  const query = {
    sources: ["codex"] as const,
    start: null,
    end: null,
    projectDir: null,
    text: "needle",
    limit: 10,
  };
  try {
    process.env.CODEX_HOME = dir;
    await mkdir(root);
    await writeFile(path, records);
    clearSummaryCache();
    READERS.codex.summarize = async (file) => {
      const summary = await summarize(file);
      await unlink(file);
      return summary;
    };
    const found = await searchSessions(query);
    expect(found.sessions).toEqual([]);
    expect(found.complete).toBe(true);
    expect(warning).toHaveBeenCalled();
    await writeFile(path, records);
    clearSummaryCache();
    READERS.codex.summarize = async () => {
      throw new TypeError("reader bug");
    };
    await expect(searchSessions(query)).rejects.toThrow("reader bug");
  } finally {
    READERS.codex.summarize = summarize;
    clearSummaryCache();
    warning.mockRestore();
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
  expect(sessionQuery({ from: "20261101" }).start).toEqual(
    sessionQuery({ from: "2026-11-01" }).start,
  );
  expect(() => sessionQuery({ limit: 0 })).toThrow("limit must be");
  expect(() => sessionQuery({ text: "x".repeat(501) })).toThrow("text must be");
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
    const listed = JSON.parse(lines[0] ?? "[]");
    expect(listed).toHaveLength(1);
    expect(listed[0].session_id).toBe("s");
    expect(listed[0].started_at).toBe("2026-11-10T10:00:00Z");
    expect(listed[0]).not.toHaveProperty("sessionId");
    const wire = JSON.parse(await readFile(output, "utf8"));
    expect(wire.documents[0].metadata.trace_id).toBe("codex:s");
    expect(wire.documents[0].metadata).not.toHaveProperty("traceId");
    expect(wire.documents[0].trajectory.steps[0]).toHaveProperty(
      "tool_calls",
      null,
    );
    if (process.env.EVALUATORQ_PYTHON) {
      const checked = spawnSync(
        process.env.EVALUATORQ_PYTHON,
        [
          "-c",
          `
import json, sys
from evaluatorq.trace_finder.models import Snapshot
from evaluatorq.local_sessions.models import SessionSummary
Snapshot.model_validate_json(open(sys.argv[1], encoding="utf-8").read())
SessionSummary.model_validate(json.loads(sys.argv[2])[0])
print("Python accepted snapshot and session listing")
`,
          output,
          lines[0] ?? "[]",
        ],
        { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toContain(
        "Python accepted snapshot and session listing",
      );
    }
    const snapshot = new Snapshot(wire);
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
