import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  cardFromManifest,
  fingerprint,
  loadSurface,
  loadSurfaceStrict,
  manifestCardId,
  reportId,
  scan,
  sniffKind,
} from "../../src/lib/common/dashboard/library.js";
import { ManifestSurface, type RunManifest } from "../../src/lib/contracts.js";

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "run-1",
    surface: ManifestSurface.SIM,
    runName: "My Sim Run",
    status: "running",
    stage: null,
    stages: [],
    plannedStages: [],
    stageLabels: {},
    startedAt: new Date("2026-01-02T03:04:05Z"),
    updatedAt: new Date("2026-01-02T03:04:05Z"),
    endedAt: null,
    error: null,
    reportPath: null,
    parallelism: null,
    summary: null,
    summaryVersion: null,
    ...overrides,
  };
}

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = resolve(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("reportId", () => {
  it("is stable, url-safe and equal for relative, absolute and symlinked paths", async () => {
    const dir = await tempDir("dash-id-");
    await writeFile(join(dir, "abc.json"), "{}", "utf8");
    const fromAbsolute = await reportId(join(dir, "abc.json"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const fromRelative = await reportId("abc.json");
      expect(fromRelative).toBe(fromAbsolute);
    } finally {
      process.chdir(cwd);
    }
    const link = join(dir, "link.json");
    await symlink(join(dir, "abc.json"), link);
    expect(await reportId(link)).toBe(fromAbsolute);
    expect(fromAbsolute).not.toContain("=");
    expect(fromAbsolute).not.toContain("/");
    expect(fromAbsolute).not.toContain("+");
    expect(fromAbsolute).not.toBe(await reportId(join(dir, "other.json")));
  });
});

describe("manifestCardId", () => {
  it("is namespaced away from reportId", async () => {
    expect(manifestCardId("run-1")).not.toBe(await reportId("run-1"));
    expect(manifestCardId("run-1")).toBe(manifestCardId("run-1"));
  });
});

describe("sniffKind", () => {
  it("maps single fields to surfaces, sim checked first", () => {
    expect(sniffKind({ mode: "run" })).toBe("sim");
    expect(sniffKind({ pipeline: "x" })).toBe("redteam");
    expect(sniffKind({ judging: "pairwise" })).toBe("pairwise");
    expect(sniffKind({})).toBeNull();
  });
});

describe("loadSurface", () => {
  it("masks corrupt, array and scalar JSON as unknown", async () => {
    const dir = await tempDir("dash-bad-");
    for (const [name, content] of [
      ["bad.json", "{not json"],
      ["arr.json", "[1,2]"],
      ["scalar.json", "42"],
    ] as const) {
      const path = join(dir, name);
      await writeFile(path, content, "utf8");
      const [surface, data] = await loadSurface(path);
      expect(surface).toBeNull();
      expect(data).toEqual({});
    }
  });

  it("strict variant raises on corrupt and non-object JSON", async () => {
    const dir = await tempDir("dash-strict-");
    for (const content of ["{not json", "[1,2]", "42"]) {
      const path = join(dir, "f.json");
      await writeFile(path, content, "utf8");
      expect(loadSurfaceStrict(path)).rejects.toThrow();
    }
  });
});

describe("cardFromManifest", () => {
  it("uses the compact summary headline for a completed run", async () => {
    const dir = await tempDir("dash-man-");
    const reportPath = join(dir, "x.json");
    const card = cardFromManifest(
      manifest({
        status: "completed",
        summary: { totalResults: 7 },
        reportPath,
      }),
    );
    expect(await card.id).toBe(await reportId(reportPath));
    expect(card.headline).toBe("7 conversations");
    expect(card.status).toBe("completed");
  });

  it("uses attack nouns for redteam", () => {
    const card = cardFromManifest(
      manifest({
        surface: ManifestSurface.REDTEAM,
        status: "completed",
        summary: { totalResults: 3 },
        reportPath: "/tmp/runs/y.json",
      }),
    );
    expect(card.headline).toBe("3 attacks");
  });

  it("shows running stage", () => {
    const card = cardFromManifest(manifest({ stage: "attacking" }));
    expect(card.headline).toBe("running · attacking");
    expect(card.id).toBe(manifestCardId("run-1"));
    expect(card.path).toBeNull();
  });

  it("falls back to status for terminal in-flight runs", () => {
    expect(cardFromManifest(manifest({ status: "error" })).headline).toBe(
      "error",
    );
    expect(cardFromManifest(manifest({ status: "cancelled" })).headline).toBe(
      "cancelled",
    );
  });
});

describe("legacy card", () => {
  it("coerces the name to a string and falls back to the stem", async () => {
    const dir = await tempDir("dash-name-");
    const path = join(dir, "mystem.json");
    await writeFile(
      path,
      JSON.stringify({ mode: "run", run_name: "", description: null }),
      "utf8",
    );
    const [cards] = [await scan(dir)];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe("mystem");
  });

  it("stringifies a numeric run_name like Python", async () => {
    const dir = await tempDir("dash-num-");
    await writeFile(
      join(dir, "num.json"),
      JSON.stringify({
        mode: "run",
        run_name: 42,
        description: "lower priority",
      }),
      "utf8",
    );
    await writeFile(
      join(dir, "desc.json"),
      JSON.stringify({ pipeline: "p", description: 7 }),
      "utf8",
    );
    const cards = await scan(dir);
    expect(cards).toHaveLength(2);
    expect(cards.find((card) => card.path?.endsWith("num.json"))?.name).toBe(
      "42",
    );
    expect(cards.find((card) => card.path?.endsWith("desc.json"))?.name).toBe(
      "7",
    );
  });

  it("leaves the headline empty when a required field is missing", async () => {
    const dir = await tempDir("dash-req-");
    await writeFile(
      join(dir, "sim.json"),
      JSON.stringify({ mode: "run", createdAt: "2026-02-01T00:00:00Z" }),
      "utf8",
    );
    await writeFile(
      join(dir, "rt.json"),
      JSON.stringify({ pipeline: "p" }),
      "utf8",
    );
    await writeFile(
      join(dir, "pw.json"),
      JSON.stringify({ judging: "pairwise" }),
      "utf8",
    );
    const cards = await scan(dir);
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.error).not.toBeNull();
      expect(card.headline).toBe("");
    }
  });
});

describe("scan roots", () => {
  it("deduplicates equivalent roots so a run is listed once", async () => {
    const dir = await tempDir("dash-roots-");
    await writeFile(
      join(dir, "one.json"),
      JSON.stringify({ mode: "run", run_name: "One" }),
      "utf8",
    );
    const link = join(dir, "alias-dir");
    await symlink(dir, link);
    const cards = await scan([dir, link, dir]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe("One");
  });

  it("merges cards across distinct roots", async () => {
    const first = await tempDir("dash-roots-a-");
    const second = await tempDir("dash-roots-b-");
    await writeFile(
      join(first, "a.json"),
      JSON.stringify({ mode: "run", run_name: "A" }),
      "utf8",
    );
    await writeFile(
      join(second, "b.json"),
      JSON.stringify({ pipeline: "p", run_name: "B" }),
      "utf8",
    );
    const cards = await scan([first, second]);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.name).sort()).toEqual(["A", "B"]);
  });

  it("keeps the single-string call form working", async () => {
    const dir = await tempDir("dash-roots-s-");
    await writeFile(
      join(dir, "a.json"),
      JSON.stringify({ mode: "run", run_name: "Solo" }),
      "utf8",
    );
    const cards = await scan(dir);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe("Solo");
  });
});

describe("fingerprint", () => {
  async function writeReport(dir: string, name: string, content: object) {
    await writeFile(join(dir, name), JSON.stringify(content), "utf8");
  }

  it("changes when a report is added", async () => {
    const dir = await tempDir("dash-fp-1-");
    const first = await fingerprint(dir);
    await writeReport(dir, "a.json", { mode: "run" });
    const second = await fingerprint(dir);
    expect(second.count).toBe(first.count + 1);
    expect(second.identity).not.toBe(first.identity);
    expect(second.newestMtimeNs).toBeGreaterThanOrEqual(first.newestMtimeNs);
  });

  it("ignores stage artifact files but counts manifests", async () => {
    const dir = await tempDir("dash-fp-2-");
    await writeReport(dir, "run.json", { mode: "run" });
    await writeReport(dir, "01_stage.json", { stage: true });
    await mkdir(join(dir, ".manifests"), { recursive: true });
    await writeFile(
      join(dir, ".manifests", "run.json"),
      JSON.stringify(manifest({ runId: "run" })),
      "utf8",
    );
    const fp = await fingerprint(dir);
    expect(fp.count).toBe(2);
  });

  it("detects a same-mtime manifest rewrite through identity", async () => {
    const dir = await tempDir("dash-fp-3-");
    const manifestPath = join(dir, ".manifests", "run.json");
    await mkdir(join(dir, ".manifests"), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(manifest({ runId: "run", stage: "a" })),
      "utf8",
    );
    const original = await stat(manifestPath);
    const before = await fingerprint(dir);
    const replacement = join(dir, ".manifests", "replacement.tmp");
    await writeFile(replacement, await readFile(manifestPath));
    await utimes(replacement, original.atime, original.mtime);
    await rename(replacement, manifestPath);
    const after = await fingerprint(dir);
    expect(after.identity).not.toBe(before.identity);
  });

  it("is identical for repeated equivalent roots", async () => {
    const dir = await tempDir("dash-fp-4-");
    await writeReport(dir, "a.json", { mode: "run" });
    const link = join(dir, "alias-dir");
    await symlink(dir, link);
    const single = await fingerprint(dir);
    const repeated = await fingerprint([dir, link, dir]);
    expect(repeated.count).toBe(single.count);
    expect(repeated.newestMtimeNs).toBe(single.newestMtimeNs);
    expect(repeated.identity).toBe(single.identity);
  });
});

describe("pairwise headline", () => {
  async function pairwiseCard(dir: string, data: object) {
    const path = join(dir, "pw.json");
    await writeFile(path, JSON.stringify(data), "utf8");
    const cards = await scan(dir);
    return cards[0];
  }

  it("counts comparisons and reports even", async () => {
    const dir = await tempDir("dash-pw-1-");
    const card = await pairwiseCard(dir, {
      judging: "pairwise",
      label_a: "GPT",
      label_b: "Claude",
      entries: [
        { comparison: { winner: "A" } },
        { comparison: { winner: "B" } },
      ],
    });
    expect(card?.headline).toBe("2 comparisons · even");
  });

  it("reports a labelled lead with the Wilson bound", async () => {
    const dir = await tempDir("dash-pw-2-");
    const card = await pairwiseCard(dir, {
      judging: "pairwise",
      label_a: "GPT",
      label_b: "Claude",
      entries: [
        { comparison: { winner: "A" } },
        { comparison: { winner: "A" } },
        { comparison: { winner: "A" } },
        { comparison: { winner: "B" } },
      ],
    });
    expect(card?.headline).toBe("4 comparisons · GPT leads 75% · too close");
  });

  it("flags a too-close lead and skips malformed entries", async () => {
    const dir = await tempDir("dash-pw-3-");
    const card = await pairwiseCard(dir, {
      judging: "pairwise",
      entries: [
        { comparison: { winner: "A" } },
        { comparison: { winner: "A" } },
        { comparison: { winner: "A" } },
        { comparison: { winner: "B" } },
        { comparison: { winner: "tie" } },
        "not-an-entry",
        { comparison: "nope" },
      ],
    });
    expect(card?.headline).toBe("7 comparisons · A leads 75% · too close");
  });
});
