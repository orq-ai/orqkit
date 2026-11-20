import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ADAPTERS } from "../../../src/lib/dashboard/surfaces.js";
import type { PairwiseRun } from "../../../src/lib/pairwise-run.js";

const run = {
  runName: "demo",
  createdAt: "2026-11-09T10:20:30Z",
  labelA: "Old",
  labelB: "New",
  judges: ["j1", "j2"],
  entries: [
    {
      question: "Q1",
      responseA: "a",
      responseB: "b",
      comparison: { winner: "A", votes: [{ model: "j1", vote: "A" }] },
    },
    {
      question: "Q2",
      responseA: "a",
      responseB: "b",
      comparison: {
        winner: "inconclusive",
        votes: [
          { model: "j2", vote: "tie" },
          { model: "j1", vote: null },
        ],
      },
    },
  ],
};

describe("surface adapters", () => {
  it("loads a pairwise run and exports label-resolved rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surfaces-"));
    const path = join(dir, "run.json");
    writeFileSync(path, JSON.stringify(run));
    const adapter = ADAPTERS.pairwise as unknown as {
      load: (p: string) => Promise<PairwiseRun>;
      name: (r: PairwiseRun) => string;
      createdAt: (r: PairwiseRun) => Date;
      exportMarkdown: unknown;
      rows: (r: PairwiseRun, e: PairwiseRun["entries"]) => unknown[];
    };
    const loaded = await adapter.load(path);
    expect(adapter.name(loaded)).toBe("demo");
    expect(adapter.createdAt(loaded).toISOString()).toBe(
      "2026-11-09T10:20:30.000Z",
    );
    expect(adapter.exportMarkdown).toBeNull();
    expect(adapter.rows(loaded, loaded.entries)).toEqual([
      { "#": 1, Question: "Q1", Winner: "Old", j1: "Old", j2: "" },
      {
        "#": 2,
        Question: "Q2",
        Winner: "inconclusive",
        j1: "abstained",
        j2: "tie",
      },
    ]);
  });

  it("registers the three dashboard surfaces", () => {
    expect(Object.keys(ADAPTERS)).toEqual(["redteam", "sim", "pairwise"]);
    expect(ADAPTERS.redteam?.exportMarkdown).not.toBeNull();
    expect(ADAPTERS.sim?.rows).not.toBeNull();
  });
});
