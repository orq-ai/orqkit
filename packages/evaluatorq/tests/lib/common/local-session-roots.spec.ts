import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FAMILY_OF,
  SESSION_SOURCES,
} from "../../../src/lib/local-sessions/models.js";
import { sessionRoots } from "../../../src/lib/local-sessions/roots.js";

test("session roots honor per-tool overrides and include only existing directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-roots-")),
    previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    expect(await sessionRoots("omp")).toEqual([]);
    await mkdir(join(dir, "sessions"));
    expect(await sessionRoots("omp")).toEqual([join(dir, "sessions")]);
    expect(SESSION_SOURCES.map((source) => FAMILY_OF[source])).toEqual([
      "claude",
      "claude",
      "codex",
      "omp",
    ]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
