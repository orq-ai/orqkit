import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ReportCard,
  reportId,
} from "../../../src/lib/common/dashboard/library.js";
import {
  landing,
  redteamCounts,
  redteamOverview,
  redteamRunStats,
  redteamTiles,
  resultOutcome,
  runRows,
  simOverview,
  summarySeverity,
  UNKNOWN_SEVERITY,
} from "../../../src/lib/dashboard/metrics.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tmpRoots(
  extra = "",
): Promise<{ dir: string; rt: string; sim: string }> {
  const dir = await mkdtemp(join(tmpdir(), `eq-metrics-${extra}-`));
  dirs.push(dir);
  const rt = join(dir, "runs");
  const sim = join(dir, "sim-runs");
  await mkdir(rt);
  await mkdir(sim);
  return { dir, rt, sim };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

const close = (actual: number, expected: number, eps = 1e-9): void => {
  expect(Math.abs(actual - expected)).toBeLessThan(eps);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function redteamPayload(
  name: string,
  options: {
    created: string;
    resistance: number | null;
    vulns: number;
    evaluated: number;
    tokens: number;
    severity: Record<string, number>;
  },
): Record<string, unknown> {
  return {
    pipeline: { mode: "adaptive" },
    created_at: options.created,
    run_name: name,
    total_results: options.evaluated,
    results: [
      {
        attack: { severity: "critical", strategy_name: "direct_override" },
        agent: { display_name: "Refund agent", model: "gpt-5.4" },
        vulnerable: true,
        error: null,
      },
      {
        attack: { severity: "low", strategy_name: "roleplay" },
        agent: { display_name: "Refund agent", model: "gpt-5.4" },
        vulnerable: false,
        error: null,
      },
    ],
    summary: {
      resistance_rate: options.resistance,
      vulnerabilities_found: options.vulns,
      evaluated_attacks: options.evaluated,
      token_usage_total: { total_tokens: options.tokens, cost_usd: 0.0048 },
      by_severity: Object.fromEntries(
        Object.entries(options.severity).map(([key, value]) => [
          key,
          { vulnerabilities_found: value },
        ]),
      ),
    },
  };
}

function legacyRedteamPayload(
  name: string,
  options: {
    created: string;
    resistance: number | null;
    results: Record<string, unknown>[];
  },
): Record<string, unknown> {
  return {
    pipeline: { mode: "adaptive" },
    created_at: options.created,
    run_name: name,
    total_results: options.results.length,
    results: options.results,
    summary: { resistance_rate: options.resistance },
  };
}

function legacyResult(options: {
  vulnerable?: boolean;
  error?: string | null;
  severity?: string;
  evaluation?: Record<string, unknown> | null;
  tokens?: number;
}): Record<string, unknown> {
  const res: Record<string, unknown> = {
    attack: { severity: options.severity ?? "low" },
    vulnerable: options.vulnerable ?? false,
    error: options.error ?? null,
  };
  if (options.evaluation !== undefined) {
    res.evaluation = options.evaluation;
  }
  if (options.tokens) {
    res.execution = {
      token_usage: {
        total_tokens: options.tokens,
        cost_usd: options.tokens * 0.001,
      },
    };
  }
  return res;
}

function simPayload(
  name: string,
  options: {
    created: string;
    averages: Record<string, number>;
    n: number;
    tokEach: number;
  },
): Record<string, unknown> {
  return {
    mode: "run",
    created_at: options.created,
    run_name: name,
    total_results: options.n,
    scorer_averages: options.averages,
    results: Array.from({ length: options.n }, () => ({
      total_tokens: options.tokEach,
    })),
  };
}

async function seedStandardRoots(): Promise<{ rt: string; sim: string }> {
  const { rt, sim } = await tmpRoots("std");
  await writeJson(
    join(rt, "refund_20260624_101500.json"),
    redteamPayload("Refund agent probe", {
      created: "2026-06-24T10:15:00",
      resistance: 0.86,
      vulns: 18,
      evaluated: 128,
      tokens: 412000,
      severity: { critical: 3, high: 7, medium: 6, low: 2 },
    }),
  );
  await writeJson(
    join(sim, "support_20260625_140000.json"),
    simPayload("Support agent simulation", {
      created: "2026-06-25T14:00:00",
      averages: { helpfulness: 0.91, safety: 0.97 },
      n: 40,
      tokEach: 1550,
    }),
  );
  return { rt, sim };
}

// ---------------------------------------------------------------------------
// run rows + landing
// ---------------------------------------------------------------------------

describe("run rows and landing", () => {
  test("run rows kinds and scores", async () => {
    const { rt, sim } = await seedStandardRoots();
    const rows = await runRows([rt, sim]);
    const bySurface = Object.fromEntries(rows.map((r) => [r.surface, r]));
    expect(Object.keys(bySurface).sort()).toEqual(["redteam", "sim"]);
    close(bySurface.redteam?.score as number, 0.86);
    expect(bySurface.redteam?.status).toBe("finished");
    close(bySurface.sim?.score as number, (0.91 + 0.97) / 2);
  });

  test("landing aggregates", async () => {
    const { rt, sim } = await seedStandardRoots();
    const data = await landing([rt, sim]);
    expect(data.totalRuns).toBe(2);
    expect(data.redteamRuns).toBe(1);
    expect(data.simRuns).toBe(1);
    expect(data.resistant).toBe(110);
    expect(data.vulnerable).toBe(18);
    expect(data.severity).toEqual([
      ["critical", 3],
      ["high", 7],
      ["medium", 6],
      ["low", 2],
    ]);
    expect(Object.fromEntries(data.tokensByKind)["Red team"]).toBe(412000);
    expect(Object.fromEntries(data.tokensByKind)["Agent sim"]).toBe(40 * 1550);
    expect(data.recent).toHaveLength(2);
  });

  test("landing includes legacy redteam counts", async () => {
    const { rt, sim } = await seedStandardRoots();
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Legacy probe", {
        created: "2026-01-01T00:00:00",
        resistance: 2 / 3,
        results: [
          legacyResult({ vulnerable: false }),
          legacyResult({ vulnerable: false }),
          legacyResult({ vulnerable: true }),
          legacyResult({ vulnerable: false, error: "timeout" }),
        ],
      }),
    );
    const data = await landing([rt, sim]);
    expect(data.resistant).toBe(112);
    expect(data.vulnerable).toBe(19);
    close(data.resistanceRate as number, 112 / 131);
  });

  test("landing legacy without results is not counted", async () => {
    const { rt } = await tmpRoots("noruns");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Rate only", {
        created: "2026-01-01T00:00:00",
        resistance: 0.5,
        results: [],
      }),
    );
    const data = await landing([rt]);
    expect(data.redteamRuns).toBe(1);
    expect(data.resistant).toBe(0);
    expect(data.vulnerable).toBe(0);
    expect(data.resistanceRate).toBeNull();
  });

  test("legacy row keeps its recorded rate when nothing is derivable", async () => {
    const { rt } = await tmpRoots("keeperate");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Rate only", {
        created: "2026-01-01T00:00:00",
        resistance: 0.5,
        results: [],
      }),
    );
    const row = (await runRows([rt]))[0];
    close(row.score as number, 0.5);
    expect(row.storedScore).toBeNull();
  });

  test("legacy cost fallback uses per-result cost", async () => {
    const { rt } = await tmpRoots("costfb");
    const report = join(rt, "legacy.json");
    await writeJson(
      report,
      legacyRedteamPayload("Legacy cost fallback", {
        created: "2026-01-01T00:00:00",
        resistance: 1.0,
        results: [legacyResult({ tokens: 100 })],
      }),
    );
    const stats = await redteamRunStats(
      report,
      (await stat(report, { bigint: true })).mtimeNs,
    );
    expect(stats).not.toBeNull();
    close(stats?.cost as number, 0.1);
  });

  test("legacy redteam stats match landing cost and derive resistance", async () => {
    const { rt, sim } = await tmpRoots("legacycostres");
    const payload = legacyRedteamPayload("Legacy cost and resistance", {
      created: "2026-06-29T10:00:00",
      resistance: null,
      results: [
        legacyResult({ vulnerable: true, tokens: 10 }),
        legacyResult({ vulnerable: false, tokens: 20 }),
      ],
    });
    const report = join(rt, "legacy.json");
    await writeJson(report, payload);

    const counts = redteamCounts(payload);
    const stats = await redteamRunStats(
      report,
      (await stat(report, { bigint: true })).mtimeNs,
    );
    const landingData = await landing([rt, sim]);

    expect(stats).not.toBeNull();
    close(counts.cost as number, 0.03);
    close(stats?.cost as number, counts.cost as number);
    close(landingData.totalCost as number, counts.cost as number);
    close(stats?.resistance as number, 0.5);
  });

  test("unreadable summary cost falls back to result cost", async () => {
    const { rt } = await tmpRoots("unread");
    const payload = legacyRedteamPayload("Unreadable summary cost", {
      created: "2026-01-01T00:00:00",
      resistance: 1.0,
      results: [legacyResult({ tokens: 100 })],
    });
    payload.summary = {
      resistance_rate: 1.0,
      token_usage_total: { total_tokens: 100, cost_usd: "provider-drift" },
    };
    const result = payload.results as Array<Record<string, unknown>>;
    (result[0]?.execution as Record<string, unknown>).token_usage = {
      total_tokens: 100,
      cost_usd: 0.007,
    };
    const report = join(rt, "unreadable-summary-cost.json");
    await writeJson(report, payload);
    const stats = await redteamRunStats(
      report,
      (await stat(report, { bigint: true })).mtimeNs,
    );
    expect(stats).not.toBeNull();
    close(stats?.cost as number, 0.007);
  });

  test("legacy zero cost is known and consistent across overviews", async () => {
    const { rt, sim } = await tmpRoots("zerocost");
    const payload = legacyRedteamPayload("Known zero cost", {
      created: "2026-01-01T00:00:00",
      resistance: 1.0,
      results: [legacyResult({ tokens: 100 })],
    });
    const result = payload.results as Array<Record<string, unknown>>;
    (result[0]?.execution as Record<string, unknown>).token_usage = {
      total_tokens: 100,
      cost_usd: 0.0,
    };
    const report = join(rt, "known-zero-cost.json");
    await writeJson(report, payload);
    const stats = await redteamRunStats(
      report,
      (await stat(report, { bigint: true })).mtimeNs,
    );
    const data = await landing([rt, sim]);
    expect(stats?.cost).toBe(0.0);
    expect(data.totalCost).toBe(0.0);
  });

  test("legacy row marks a rate it recalculated", async () => {
    const { rt } = await tmpRoots("recalc");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Judge crashed", {
        created: "2026-01-01T00:00:00",
        resistance: 0.5,
        results: [
          legacyResult({ evaluation: { passed: true } }),
          legacyResult({ evaluation: { passed: null } }),
        ],
      }),
    );
    const row = (await runRows([rt]))[0];
    close(row.score as number, 1.0);
    close(row.storedScore as number, 0.5);
    expect([row.evaluated, row.attacks]).toEqual([1, 2]);
  });

  test("legacy row is unmarked when the derivation agrees", async () => {
    const { rt } = await tmpRoots("agrees");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Agrees", {
        created: "2026-01-01T00:00:00",
        resistance: 0.5,
        results: [
          legacyResult({ evaluation: { passed: true } }),
          legacyResult({ evaluation: { passed: false } }),
        ],
      }),
    );
    const row = (await runRows([rt]))[0];
    close(row.score as number, 0.5);
    expect(row.storedScore).toBeNull();
  });

  test("landing legacy severity and tokens are derived", async () => {
    const { rt } = await tmpRoots("legsev");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Legacy probe", {
        created: "2026-01-01T00:00:00",
        resistance: 0.5,
        results: [
          legacyResult({ vulnerable: true, severity: "critical", tokens: 100 }),
          legacyResult({ vulnerable: true, severity: "low", tokens: 100 }),
          legacyResult({ vulnerable: false, tokens: 200 }),
        ],
      }),
    );
    const data = await landing([rt]);
    expect(Object.fromEntries(data.severity)).toEqual({ critical: 1, low: 1 });
    expect(Object.fromEntries(data.tokensByKind)["Red team"]).toBe(400);
    expect(data.totalTokens).toBe(400);
    close(Object.fromEntries(data.costByKind)["Red team"] as number, 0.4);
  });

  test("landing evaluation failure is not counted as resistant", async () => {
    const { rt } = await tmpRoots("evalfail");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Judge crashed", {
        created: "2026-01-01T00:00:00",
        resistance: 1.0,
        results: [
          legacyResult({ evaluation: { passed: true } }),
          legacyResult({ evaluation: { passed: false }, severity: "high" }),
          legacyResult({ evaluation: { passed: null } }),
        ],
      }),
    );
    const data = await landing([rt]);
    expect(data.resistant).toBe(1);
    expect(data.vulnerable).toBe(1);
    close(data.resistanceRate as number, 0.5);
  });

  test("landing legacy row score matches derived donut", async () => {
    const { rt } = await tmpRoots("donut");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Total-denominator rate", {
        created: "2026-01-01T00:00:00",
        resistance: 0.5,
        results: [
          legacyResult({ vulnerable: false }),
          legacyResult({ vulnerable: false }),
          legacyResult({ vulnerable: true }),
          legacyResult({ vulnerable: false, error: "timeout" }),
        ],
      }),
    );
    const data = await landing([rt]);
    const row = data.recent.find((r) => r.surface === "redteam");
    close(row?.score as number, 2 / 3);
    close(data.resistanceRate as number, 2 / 3);
  });

  test("landing legacy result without vulnerable key is unknown", async () => {
    const { rt } = await tmpRoots("nokey");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Truncated record", {
        created: "2026-01-01T00:00:00",
        resistance: 1.0,
        results: [
          { attack: { severity: "low" } },
          legacyResult({ vulnerable: true, severity: "high" }),
        ],
      }),
    );
    const data = await landing([rt]);
    expect(data.resistant).toBe(0);
    expect(data.vulnerable).toBe(1);
    close(data.resistanceRate as number, 0.0);
  });

  test("landing empty", async () => {
    const { dir } = await tmpRoots("empty");
    const empty = [join(dir, "runs"), join(dir, "sim-runs")];
    const data = await landing(empty);
    expect(data.totalRuns).toBe(0);
    expect(data.resistanceRate).toBeNull();
  });

  test("costed runs counted", async () => {
    const { rt, sim } = await seedStandardRoots();
    const data = await landing([rt, sim]);
    expect(data.costedRuns).toBe(1);
    close(data.totalCost as number, 0.0048);
  });

  test("redteam tile cost uses fsum so order cannot lose precision", async () => {
    const { rt } = await tmpRoots("fsum");
    const rawCosts = [1e16, 1.0, -1e16];
    const cards: ReportCard[] = [];
    for (const [i, rawCost] of rawCosts.entries()) {
      const report = join(rt, `card_${i}.json`);
      await writeJson(report, {
        summary: {
          resistance_rate: 1.0,
          vulnerabilities_found: 0,
          evaluated_attacks: 1,
          token_usage_total: { total_tokens: 1, cost_usd: rawCost },
          by_severity: {},
        },
      });
      cards.push({
        id: `card_${i}`,
        surface: "redteam",
        name: `card ${i}`,
        createdAt: new Date("2026-06-24T10:15:00"),
        headline: "",
        path: report,
        error: null,
        status: null,
        stage: null,
      });
    }
    const tiles = await redteamTiles(cards);
    close(tiles.stats.cost, 1.0);
    expect(tiles.stats.cost).not.toBe(0.0);
  });

  test("landing input/output cost totals use fsum over pairwise", async () => {
    const { dir } = await tmpRoots("pwfsum");
    const pw = join(dir, "pairwise-runs");
    await mkdir(pw);
    const raw = [1e16, 1.0, -1e16];
    await writeJson(join(pw, "pw_fsum.json"), {
      judging: {},
      created_at: "2026-06-24T10:15:00",
      run_name: "pw fsum",
      entries: raw.map((c) => ({
        comparison: { token_usage: { input_cost: c, output_cost: c } },
      })),
    });
    const data = await landing([pw]);
    close(data.totalInputCost as number, 1.0);
    close(data.totalOutputCost as number, 1.0);
  });

  test("landing does not count null cost as costed", async () => {
    const { rt, sim } = await tmpRoots("nullcost");
    await writeJson(
      join(rt, "p.json"),
      redteamPayload("P", {
        created: "2026-06-29T10:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const path = join(rt, "p.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    (parsed.summary as Record<string, unknown>).token_usage_total = {
      total_tokens: 500,
      cost_usd: null,
    };
    await writeJson(path, parsed);
    const data = await landing([rt, sim]);
    expect(data.costedRuns).toBe(0);
    expect(data.totalCost).toBeNull();
  });

  test("redteam overview does not count null cost", async () => {
    const { rt, sim } = await tmpRoots("rtnull");
    await writeJson(
      join(rt, "p.json"),
      redteamPayload("P", {
        created: "2026-06-29T10:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const path = join(rt, "p.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    (parsed.summary as Record<string, unknown>).token_usage_total = {
      total_tokens: 500,
      cost_usd: null,
    };
    await writeJson(path, parsed);
    const ov = await redteamOverview([rt, sim]);
    expect(ov.totalCost).toBeNull();
    expect(ov.recent[0]?.cost).toBeNull();
  });

  test("sim overview does not count null cost", async () => {
    const { rt, sim } = await tmpRoots("simnull");
    await writeJson(join(sim, "s.json"), {
      mode: "run",
      created_at: "2026-06-30T10:00:00",
      run_name: "S",
      total_results: 1,
      scorer_averages: {},
      results: [
        {
          token_usage: { total_tokens: 100, cost_usd: null },
          goal_achieved: true,
          turn_count: 1,
        },
      ],
    });
    const ov = await simOverview([rt, sim]);
    expect(ov.avgCost).toBeNull();
    expect(ov.recent[0]?.cost).toBeNull();
  });

  test("legacy cost_usd only still totals and shows no breakdown", async () => {
    const { rt, sim } = await tmpRoots("legacycost");
    await writeJson(
      join(rt, "p.json"),
      redteamPayload("Legacy report", {
        created: "2026-06-29T10:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const path = join(rt, "p.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    (parsed.summary as Record<string, unknown>).token_usage_total = {
      total_tokens: 500,
      cost_usd: 0.0025,
    };
    await writeJson(path, parsed);
    const data = await landing([rt, sim]);
    close(data.totalCost as number, 0.0025);
    expect(data.costedRuns).toBe(1);
    expect(data.totalInputCost).toBeNull();
    expect(data.totalOutputCost).toBeNull();
    const ov = await redteamOverview([rt, sim]);
    close(ov.totalCost as number, 0.0025);
    expect(ov.totalInputCost).toBeNull();
    expect(ov.totalOutputCost).toBeNull();
  });

  test("pre-cost report has no cost key at all", async () => {
    const { rt, sim } = await tmpRoots("nocostkey");
    await writeJson(
      join(rt, "p.json"),
      redteamPayload("Ancient report", {
        created: "2026-06-29T10:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const path = join(rt, "p.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    (parsed.summary as Record<string, unknown>).token_usage_total = {
      total_tokens: 500,
    };
    await writeJson(path, parsed);
    const data = await landing([rt, sim]);
    expect(data.costedRuns).toBe(0);
    expect(data.totalCost).toBeNull();
  });

  test("partial coverage labelled on landing and redteam", async () => {
    const { rt, sim } = await tmpRoots("coverage");
    await writeJson(
      join(rt, "p.json"),
      redteamPayload("P", {
        created: "2026-06-29T10:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const path = join(rt, "p.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    (parsed.summary as Record<string, unknown>).token_usage_total = {
      total_tokens: 500,
      cost_usd: 0.5,
      calls: 10,
      priced_calls: 3,
    };
    await writeJson(path, parsed);
    const data = await landing([rt, sim]);
    expect([data.pricedCalls, data.costCalls]).toEqual([3, 10]);
    const ov = await redteamOverview([rt, sim]);
    expect([ov.pricedCalls, ov.costCalls]).toEqual([3, 10]);
  });

  test("legacy report does not inflate the coverage denominator", async () => {
    const { rt, sim } = await tmpRoots("legacycov");
    await writeJson(
      join(rt, "legacy.json"),
      redteamPayload("L", {
        created: "2026-06-29T10:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const legacyPath = join(rt, "legacy.json");
    const legacy = JSON.parse(
      await (await import("node:fs/promises")).readFile(legacyPath, "utf8"),
    );
    const legacyUsage = (legacy.summary as Record<string, unknown>)
      .token_usage_total as Record<string, unknown>;
    legacyUsage.cost_usd = 0.5;
    legacyUsage.calls = 10;
    legacyUsage.priced_calls = undefined;
    delete legacyUsage.priced_calls;
    await writeJson(legacyPath, legacy);
    await writeJson(
      join(rt, "new.json"),
      redteamPayload("N", {
        created: "2026-06-29T11:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const newPath = join(rt, "new.json");
    const newPayload = JSON.parse(
      await (await import("node:fs/promises")).readFile(newPath, "utf8"),
    );
    (newPayload.summary as Record<string, unknown>).token_usage_total = {
      total_tokens: 500,
      cost_usd: 0.5,
      calls: 1,
      priced_calls: 1,
    };
    await writeJson(newPath, newPayload);
    const data = await landing([rt, sim]);
    expect([data.pricedCalls, data.costCalls, data.unknownCalls]).toEqual([
      1, 1, 10,
    ]);
  });

  test("legacy report with no cost contributes no unknown coverage", async () => {
    const { rt, sim } = await tmpRoots("legacynocost");
    await writeJson(
      join(rt, "legacy.json"),
      redteamPayload("L", {
        created: "2026-06-29T10:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const legacyPath = join(rt, "legacy.json");
    const legacy = JSON.parse(
      await (await import("node:fs/promises")).readFile(legacyPath, "utf8"),
    );
    const legacyUsage = (legacy.summary as Record<string, unknown>)
      .token_usage_total as Record<string, unknown>;
    legacyUsage.cost_usd = null;
    legacyUsage.calls = 10;
    legacyUsage.priced_calls = undefined;
    delete legacyUsage.priced_calls;
    await writeJson(legacyPath, legacy);
    await writeJson(
      join(rt, "new.json"),
      redteamPayload("N", {
        created: "2026-06-29T11:00:00",
        resistance: 1.0,
        vulns: 0,
        evaluated: 1,
        tokens: 500,
        severity: {},
      }),
    );
    const newPath = join(rt, "new.json");
    const newPayload = JSON.parse(
      await (await import("node:fs/promises")).readFile(newPath, "utf8"),
    );
    (newPayload.summary as Record<string, unknown>).token_usage_total = {
      total_tokens: 500,
      cost_usd: 0.5,
      calls: 1,
      priced_calls: 1,
    };
    await writeJson(newPath, newPayload);
    const data = await landing([rt, sim]);
    expect([data.pricedCalls, data.costCalls, data.unknownCalls]).toEqual([
      1, 1, 0,
    ]);
  });

  test("zero evaluated attacks has no score", async () => {
    const { rt } = await tmpRoots("zeroscore");
    await writeJson(
      join(rt, "empty_20260731_130000.json"),
      redteamPayload("empty run", {
        created: "2026-07-31T13:00:00Z",
        resistance: 1.0,
        vulns: 0,
        evaluated: 0,
        tokens: 0,
        severity: {},
      }),
    );
    const rows = await runRows([rt]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.score).toBeNull();
  });

  test("null recorded rate has no score", async () => {
    const { rt } = await tmpRoots("nullrate");
    const payload = redteamPayload("no attacks", {
      created: "2026-07-31T13:00:00Z",
      resistance: 1.0,
      vulns: 0,
      evaluated: 0,
      tokens: 0,
      severity: {},
    });
    (payload.summary as Record<string, unknown>).resistance_rate = null;
    (payload.summary as Record<string, unknown>).total_attacks = 0;
    await writeJson(join(rt, "noattacks_20260731_130000.json"), payload);
    const rows = await runRows([rt]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.score).toBeNull();
  });

  test("missing severity books an unknown bucket", async () => {
    const { rt } = await tmpRoots("nosev");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("No severity", {
        created: "2026-01-01T00:00:00",
        resistance: 0.0,
        results: [legacyResult({ vulnerable: true })],
      }),
    );
    const path = join(rt, "legacy_20260101_000000.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    delete (parsed.results[0].attack as Record<string, unknown>).severity;
    await writeJson(path, parsed);
    const data = await landing([rt]);
    expect(Object.fromEntries(data.severity)).toEqual({
      [UNKNOWN_SEVERITY]: 1,
    });
  });

  test("the bars still sum to the donut", async () => {
    const { rt } = await tmpRoots("sumsev");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("No severity", {
        created: "2026-01-01T00:00:00",
        resistance: 0.0,
        results: [legacyResult({ vulnerable: true })],
      }),
    );
    const path = join(rt, "legacy_20260101_000000.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    delete (parsed.results[0].attack as Record<string, unknown>).severity;
    await writeJson(path, parsed);
    const data = await landing([rt]);
    expect(data.severity.reduce((acc, [, n]) => acc + n, 0)).toBe(
      data.vulnerable,
    );
    expect(data.vulnerable).toBe(1);
  });

  test("unknown sorts after the real scale", async () => {
    const { rt } = await tmpRoots("sortsev");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("Mixed", {
        created: "2026-01-01T00:00:00",
        resistance: 0.0,
        results: [
          legacyResult({ vulnerable: true, severity: "critical" }),
          legacyResult({ vulnerable: true }),
        ],
      }),
    );
    const path = join(rt, "legacy_20260101_000000.json");
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    delete (parsed.results[1].attack as Record<string, unknown>).severity;
    await writeJson(path, parsed);
    const data = await landing([rt]);
    expect(data.severity.map(([sev]) => sev)).toEqual([
      "critical",
      UNKNOWN_SEVERITY,
    ]);
  });

  test("off-scale severity folds into unknown", async () => {
    const { rt } = await tmpRoots("offscale");
    await writeJson(
      join(rt, "legacy_20260101_000000.json"),
      legacyRedteamPayload("sev1", {
        created: "2026-01-01T00:00:00",
        resistance: 0.0,
        results: [legacyResult({ vulnerable: true, severity: "sev1" })],
      }),
    );
    const data = await landing([rt]);
    expect(Object.fromEntries(data.severity)).toEqual({
      [UNKNOWN_SEVERITY]: 1,
    });
  });

  test("off-scale summary severity folds into unknown", () => {
    const out = summarySeverity({
      by_severity: { Sev1: { vulnerabilities_found: 2 }, HIGH: { count: 1 } },
    });
    expect(out).toEqual({ [UNKNOWN_SEVERITY]: 2, high: 1 });
  });
});

// ---------------------------------------------------------------------------
// sim overview
// ---------------------------------------------------------------------------

function simResult(options: {
  persona: string;
  scenario: string;
  model: string;
  goal: boolean;
  score: number;
  turns: number;
  tokens: number;
  terminatedBy?: string;
}): Record<string, unknown> {
  return {
    terminated_by: options.terminatedBy ?? "judge",
    goal_achieved: options.goal,
    goal_completion_score: options.score,
    turn_count: options.turns,
    total_tokens: options.tokens,
    metadata: {
      persona: options.persona,
      scenario: options.scenario,
      model: options.model,
    },
  };
}

async function seedSimRoots(): Promise<{ rt: string; sim: string }> {
  const { rt, sim } = await tmpRoots("sim");
  await writeJson(join(sim, "support_20260625_140000.json"), {
    mode: "run",
    created_at: "2026-06-25T14:00:00",
    run_name: "Support sim",
    total_results: 3,
    scorer_averages: { goal_achieved: 0.5 },
    results: [
      simResult({
        persona: "alice",
        scenario: "billing",
        model: "gpt-5.4",
        goal: true,
        score: 0.95,
        turns: 4,
        tokens: 1200,
      }),
      simResult({
        persona: "bob",
        scenario: "refunds",
        model: "gpt-5.4",
        goal: false,
        score: 0.4,
        turns: 6,
        tokens: 1800,
      }),
      simResult({
        persona: "carol",
        scenario: "signup",
        model: "gpt-5.4",
        goal: false,
        score: 0.0,
        turns: 2,
        tokens: 500,
        terminatedBy: "error",
      }),
    ],
  });
  return { rt, sim };
}

async function storeSim(
  results: Record<string, unknown>[],
  runFields: Record<string, unknown> = {},
): Promise<string[]> {
  const { dir } = await tmpRoots("simstore");
  const sim = join(dir, "sim-runs");
  const payload: Record<string, unknown> = {
    mode: "run",
    run_name: "Goal test",
    created_at: "2026-10-24T10:00:00",
    total_results: results.length,
    scorer_averages: { quality: 1.0 },
    results,
    ...runFields,
  };
  await writeJson(join(sim, "run.json"), payload);
  return [sim];
}

describe("sim overview", () => {
  test("aggregates", async () => {
    const { rt, sim } = await seedSimRoots();
    const ov = await simOverview([rt, sim]);
    expect(ov.simulationsRun).toBe(3);
    close(ov.goalCompletion as number, 1 / 3);
    close(ov.avgTurns as number, (4 + 6 + 2) / 3);
    close(ov.avgTokens as number, (1200 + 1800 + 500) / 3);
    expect([ov.achieved, ov.notAchieved, ov.errors]).toEqual([1, 1, 1]);
  });

  test("run rows", async () => {
    const { rt, sim } = await seedSimRoots();
    const ov = await simOverview([rt, sim]);
    expect(ov.recent).toHaveLength(1);
    const row = ov.recent[0] as (typeof ov.recent)[number];
    expect(row.name).toBe("Support sim");
    expect(row.cases).toBe(3);
    close(row.score as number, 0.5);
    expect(row.status).toBe("finished");
    expect(row.rid).toBe(reportId(join(sim, "support_20260625_140000.json")));
  });

  test("target name and model", async () => {
    const { rt, sim } = await tmpRoots("target");
    await writeJson(join(sim, "named.json"), {
      mode: "run",
      created_at: "2026-06-30T10:00:00",
      run_name: "sim:x",
      target_kind: "orq_agent",
      target: "support-bot",
      target_model: "gpt-4o",
      total_results: 1,
      scorer_averages: { goal_achieved: 1.0 },
      results: [{ goal_achieved: true, turn_count: 1, metadata: {} }],
    });
    await writeJson(join(sim, "broken.json"), {
      mode: "run",
      created_at: "2026-06-29T10:00:00",
      run_name: "sim:y",
      target_kind: "orq_agent",
      target: "refund-bot",
      total_results: 2,
      scorer_averages: {},
      results: [
        { terminated_by: "error", metadata: {} },
        { terminated_by: "error", metadata: {} },
      ],
    });
    const rows = Object.fromEntries(
      (await simOverview([rt, sim])).recent.map((r) => [r.name, r]),
    );
    expect(rows["sim:x"]?.targets).toEqual([["support-bot · gpt-4o", "agent"]]);
    expect(rows["sim:y"]?.targets).toEqual([["refund-bot", "agent"]]);
    expect(rows["sim:y"]?.status).toBe("error");
  });

  test("empty", async () => {
    const { dir } = await tmpRoots("simempty");
    const ov = await simOverview([join(dir, "runs"), join(dir, "sim-runs")]);
    expect(ov.simulationsRun).toBe(0);
    expect(ov.goalCompletion).toBeNull();
    expect(ov.recent).toEqual([]);
  });

  test("slices by page", async () => {
    const { rt, sim } = await tmpRoots("simpage");
    for (let i = 0; i < 20; i += 1) {
      await writeJson(join(sim, `sim_${String(i).padStart(3, "0")}.json`), {
        mode: "run",
        created_at: `2026-06-25T14:${String(i).padStart(2, "0")}:00`,
        run_name: `Sim ${i}`,
        total_results: 1,
        scorer_averages: { goal_achieved: 0.5 },
        results: [
          simResult({
            persona: "alice",
            scenario: "billing",
            model: "gpt-5.4",
            goal: true,
            score: 0.9,
            turns: 3,
            tokens: 900,
          }),
        ],
      });
    }
    const first = await simOverview([rt, sim], { page: 1, perPage: 8 });
    expect(first.totalRuns).toBe(20);
    expect(first.page).toBe(1);
    expect(first.perPage).toBe(8);
    expect(first.recent).toHaveLength(8);
    expect(first.recent[0]?.name).toBe("Sim 19");
    const third = await simOverview([rt, sim], { page: 3, perPage: 8 });
    expect(third.recent).toHaveLength(4);
    expect(third.recent[0]?.name).toBe("Sim 3");
  });

  test("page out of range lands on last page", async () => {
    const { rt, sim } = await tmpRoots("simpagerange");
    for (let i = 0; i < 20; i += 1) {
      await writeJson(join(sim, `sim_${String(i).padStart(3, "0")}.json`), {
        mode: "run",
        created_at: `2026-06-25T14:${String(i).padStart(2, "0")}:00`,
        run_name: `Sim ${i}`,
        total_results: 1,
        scorer_averages: {},
        results: [{ goal_achieved: true, turn_count: 1, metadata: {} }],
      });
    }
    const ov = await simOverview([rt, sim], { page: 99, perPage: 8 });
    expect(ov.page).toBe(3);
    expect(ov.recent).toHaveLength(4);
    expect(ov.totalRuns).toBe(20);
  });

  test("stats cache invalidates on rewrite", async () => {
    const { dir } = await tmpRoots("simcache");
    const sim = join(dir, "sim-runs");
    const report = join(sim, "cached_20260625_140000.json");
    const one = simResult({
      persona: "a",
      scenario: "s",
      model: "m",
      goal: true,
      score: 1.0,
      turns: 2,
      tokens: 100,
    });
    await writeJson(report, {
      mode: "run",
      created_at: "2026-06-25T14:00:00",
      run_name: "Cached",
      total_results: 1,
      scorer_averages: {},
      results: [one],
    });
    expect((await simOverview([sim])).simulationsRun).toBe(1);

    await writeJson(report, {
      mode: "run",
      created_at: "2026-06-25T14:00:00",
      run_name: "Cached",
      total_results: 2,
      scorer_averages: {},
      results: [one, one],
    });
    const before = await stat(report, { bigint: true });
    await utimes(report, new Date(), new Date(Number(before.mtimeMs) + 1000));
    expect((await simOverview([sim])).simulationsRun).toBe(2);
  });

  test("picks up a new run without restart", async () => {
    const { dir } = await tmpRoots("simnew");
    const sim = join(dir, "sim-runs");
    const one = simResult({
      persona: "a",
      scenario: "s",
      model: "m",
      goal: true,
      score: 1.0,
      turns: 2,
      tokens: 100,
    });
    await writeJson(join(sim, "first_20260625_140000.json"), {
      mode: "run",
      created_at: "2026-06-25T14:00:00",
      run_name: "First",
      total_results: 1,
      scorer_averages: {},
      results: [one],
    });
    expect((await simOverview([sim])).totalRuns).toBe(1);
    await writeJson(join(sim, "second_20260626_140000.json"), {
      mode: "run",
      created_at: "2026-06-26T14:00:00",
      run_name: "Second",
      total_results: 1,
      scorer_averages: {},
      results: [one],
    });
    const after = await simOverview([sim]);
    expect(after.totalRuns).toBe(2);
    expect(after.recent[0]?.name).toBe("Second");
  });

  test("recorded total is not average and missing cost is unknown", async () => {
    const roots = await storeSim([
      {
        goal_achieved: true,
        token_usage: { cost_usd: 4.0, calls: 2, priced_calls: 2 },
      },
      {
        goal_achieved: false,
        token_usage: { cost_usd: 2.0, calls: 2, priced_calls: 2 },
      },
      {
        goal_achieved: false,
        token_usage: { cost_usd: null, calls: 2, priced_calls: 0 },
      },
    ]);
    const data = await simOverview(roots);
    close(data.totalCost as number, 6.0);
    close(data.avgCost as number, 3.0);
    close(data.recent[0]?.cost as number, 6.0);
    expect([data.pricedCalls, data.costCalls]).toEqual([4, 6]);
  });

  test("run cost round trip uses whole-run usage for spend and coverage", async () => {
    const roots = await storeSim(
      [
        {
          goal_achieved: true,
          turn_count: 1,
          token_usage: {
            total_tokens: 2,
            input_tokens: 1,
            output_tokens: 1,
            input_cost: 0.1,
            output_cost: 0.15,
            cost_usd: 0.25,
            calls: 1,
            priced_calls: 1,
          },
        },
      ],
      {
        token_usage_total: {
          total_tokens: 10,
          input_tokens: 5,
          output_tokens: 5,
          input_cost: 0.5,
          output_cost: 0.75,
          cost_usd: 1.25,
          calls: 2,
          priced_calls: 1,
        },
      },
    );
    const overview = await simOverview(roots);
    const landingData = await landing(roots);
    close(overview.totalCost as number, 1.25);
    close(overview.recent[0]?.cost as number, 1.25);
    close(overview.avgCost as number, 0.25);
    close(overview.avgInputCost as number, 0.1);
    close(overview.avgOutputCost as number, 0.15);
    expect([overview.pricedCalls, overview.costCalls]).toEqual([1, 2]);
    close(landingData.totalCost as number, 1.25);
    expect(landingData.totalTokens).toBe(10);
    close(landingData.totalInputCost as number, 0.5);
    close(landingData.totalOutputCost as number, 0.75);
    expect([landingData.pricedCalls, landingData.costCalls]).toEqual([1, 2]);
  });

  test("landing keeps missing whole-run cost components unknown", async () => {
    const roots = await storeSim(
      [
        {
          goal_achieved: true,
          token_usage: {
            total_tokens: 2,
            input_cost: 0.1,
            output_cost: 0.15,
            cost_usd: 0.25,
          },
        },
      ],
      {
        token_usage_total: {
          total_tokens: 10,
          input_cost: null,
          output_cost: 0.75,
          cost_usd: 1.25,
        },
      },
    );
    const landingData = await landing(roots);
    expect(landingData.totalTokens).toBe(10);
    expect(landingData.totalInputCost).toBeNull();
    close(landingData.totalOutputCost as number, 0.75);
  });

  test("landing legacy sim run sums result tokens and cost components", async () => {
    const roots = await storeSim([
      {
        goal_achieved: true,
        token_usage: {
          total_tokens: 2,
          input_cost: 0.1,
          output_cost: 0.15,
          cost_usd: 0.25,
          calls: 1,
          priced_calls: 1,
        },
      },
      {
        goal_achieved: false,
        token_usage: {
          total_tokens: 3,
          input_cost: 0.2,
          output_cost: 0.3,
          cost_usd: 0.5,
          calls: 2,
          priced_calls: 1,
        },
      },
    ]);
    const landingData = await landing(roots);
    expect(landingData.totalTokens).toBe(5);
    close(landingData.totalCost as number, 0.75);
    close(landingData.totalInputCost as number, 0.3);
    close(landingData.totalOutputCost as number, 0.45);
  });

  test.each([
    [null, null],
    [0.0, 0.0],
  ])(
    "run cost distinguishes unknown from zero (%p)",
    async (runCost, expected) => {
      const roots = await storeSim(
        [
          {
            goal_achieved: true,
            token_usage: { cost_usd: 0.25, calls: 1, priced_calls: 1 },
          },
        ],
        {
          token_usage_total: {
            cost_usd: runCost,
            calls: 1,
            priced_calls: runCost === null ? 0 : 1,
          },
        },
      );
      const overview = await simOverview(roots);
      if (expected === null) {
        expect(overview.totalCost).toBeNull();
        expect(overview.recent[0]?.cost).toBeNull();
      } else {
        close(overview.totalCost as number, expected);
        close(overview.recent[0]?.cost as number, expected);
      }
      close(overview.avgCost as number, 0.25);
    },
  );

  test("goal rate is independent of scorer average and retains errors", async () => {
    const roots = await storeSim([
      { goal_achieved: true },
      { goal_achieved: false },
      { goal_achieved: true, terminated_by: "error" },
    ]);
    const data = await simOverview(roots);
    close(data.goalCompletion as number, 1 / 3);
    expect(data.recent[0]?.score).toBe(1.0);
    expect(data.recent[0]?.achieved).toBe(1);
  });

  test("all errors have no goal verdict and missing spend stays unknown", async () => {
    const roots = await storeSim([
      { goal_achieved: true, terminated_by: "error" },
    ]);
    const data = await simOverview(roots);
    expect(data.goalCompletion).toBeNull();
    expect(data.totalCost).toBeNull();
    expect([data.achieved, data.notAchieved, data.errors]).toEqual([0, 0, 1]);
  });

  test.each([
    { error: "judge request timed out" },
    { criteria_errors: ["criterion judge failed"] },
  ])("saved metadata errors match report outcomes", async (errorMetadata) => {
    const roots = await storeSim([
      {
        terminated_by: "judge",
        goal_achieved: true,
        turn_count: 1,
        total_tokens: 2,
        metadata: errorMetadata,
      },
    ]);
    const overview = await simOverview(roots);
    expect(overview.goalCompletion).toBeNull();
    expect([overview.achieved, overview.notAchieved, overview.errors]).toEqual([
      0, 0, 1,
    ]);
    expect(overview.recent[0]?.achieved).toBe(0);
    expect(overview.recent[0]?.errors).toBe(1);
  });

  test("zero cost is known and out-of-range page keeps rows", async () => {
    const roots = await storeSim([
      { goal_achieved: true, token_usage: { cost_usd: 0.0 } },
    ]);
    const data = await simOverview(roots, { page: 999 });
    expect(data.page).toBe(1);
    expect(data.recent).toHaveLength(1);
    expect(data.totalCost).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// red team overview
// ---------------------------------------------------------------------------

function attack(options: {
  severity: string;
  vulnerable: boolean;
  model?: string;
  error?: boolean;
}): Record<string, unknown> {
  return {
    attack: { severity: options.severity, strategy_name: "direct_override" },
    agent: { display_name: "Refund agent", model: options.model ?? "gpt-5.4" },
    vulnerable: options.vulnerable,
    error: options.error ? "boom" : null,
  };
}

async function seedRedteamRoots(): Promise<{ rt: string; sim: string }> {
  const { rt, sim } = await tmpRoots("rt");
  const results = [
    attack({ severity: "critical", vulnerable: true }),
    attack({ severity: "high", vulnerable: false }),
    attack({ severity: "low", vulnerable: false }),
    attack({ severity: "medium", vulnerable: false, error: true }),
  ];
  const evaluated = results.filter((r) => !r.error).length;
  const vulns = results.filter((r) => r.vulnerable && !r.error).length;
  await writeJson(join(rt, "probe_20260629_101500.json"), {
    pipeline: { mode: "adaptive" },
    created_at: "2026-06-29T10:15:00",
    run_name: "Probe",
    total_results: results.length,
    results,
    summary: {
      resistance_rate: evaluated ? (evaluated - vulns) / evaluated : 1.0,
      vulnerabilities_found: vulns,
      evaluated_attacks: evaluated,
      token_usage_total: { total_tokens: 22650, cost_usd: 0.0048 },
      by_severity: {},
    },
  });
  return { rt, sim };
}

describe("red team overview", () => {
  test("aggregates", async () => {
    const { rt, sim } = await seedRedteamRoots();
    const ov = await redteamOverview([rt, sim]);
    expect(ov.attacksRun).toBe(4);
    close(ov.breakRate as number, 1 / 3);
    close(ov.avgRobustness as number, 2 / 3);
    expect(ov.criticalFindings).toBe(1);
    close(ov.totalCost as number, 0.0048);
  });

  test("run rows", async () => {
    const { rt, sim } = await seedRedteamRoots();
    const ov = await redteamOverview([rt, sim]);
    expect(ov.recent).toHaveLength(1);
    const row = ov.recent[0] as (typeof ov.recent)[number];
    expect(row.rid).toBe(reportId(join(rt, "probe_20260629_101500.json")));
    expect(row.name).toBe("Probe");
    expect(row.cases).toBe(4);
    expect(row.targets).toEqual([["Refund agent", "llm"]]);
    close(row.score as number, 2 / 3);
    close(row.cost as number, 0.0048);
  });

  test("slices by page", async () => {
    const { rt, sim } = await tmpRoots("rtpage");
    for (let i = 0; i < 20; i += 1) {
      await writeJson(join(rt, `probe_${String(i).padStart(3, "0")}.json`), {
        pipeline: { mode: "adaptive" },
        created_at: `2026-06-29T10:${String(i).padStart(2, "0")}:00`,
        run_name: `Probe ${i}`,
        total_results: 1,
        results: [attack({ severity: "low", vulnerable: false })],
        summary: {
          resistance_rate: 1.0,
          vulnerabilities_found: 0,
          evaluated_attacks: 1,
          token_usage_total: { total_tokens: 1, cost_usd: 0.001 },
          by_severity: {},
        },
      });
    }
    const first = await redteamOverview([rt, sim], { page: 1, perPage: 8 });
    expect(first.totalRuns).toBe(20);
    expect(first.recent).toHaveLength(8);
    expect(first.recent[0]?.name).toBe("Probe 19");
    const third = await redteamOverview([rt, sim], { page: 3, perPage: 8 });
    expect(third.recent).toHaveLength(4);
    expect(third.recent[0]?.name).toBe("Probe 3");
  });

  test("page past the end shows the last page", async () => {
    const { rt, sim } = await tmpRoots("rtpageend");
    for (let i = 0; i < 20; i += 1) {
      await writeJson(join(rt, `probe_${String(i).padStart(3, "0")}.json`), {
        pipeline: { mode: "adaptive" },
        created_at: `2026-06-29T10:${String(i).padStart(2, "0")}:00`,
        run_name: `Probe ${i}`,
        total_results: 1,
        results: [attack({ severity: "low", vulnerable: false })],
        summary: {
          resistance_rate: 1.0,
          vulnerabilities_found: 0,
          evaluated_attacks: 1,
          token_usage_total: { total_tokens: 1, cost_usd: 0.001 },
          by_severity: {},
        },
      });
    }
    const ov = await redteamOverview([rt, sim], { page: 99, perPage: 8 });
    expect(ov.page).toBe(3);
    expect(ov.recent.map((r) => r.name)).toEqual(
      (await redteamOverview([rt, sim], { page: 3 })).recent.map((r) => r.name),
    );
    expect(ov.totalRuns).toBe(20);
  });

  test("per page 25 fits all", async () => {
    const { rt, sim } = await tmpRoots("rtpage25");
    for (let i = 0; i < 20; i += 1) {
      await writeJson(join(rt, `probe_${String(i).padStart(3, "0")}.json`), {
        pipeline: { mode: "adaptive" },
        created_at: `2026-06-29T10:${String(i).padStart(2, "0")}:00`,
        run_name: `Probe ${i}`,
        total_results: 1,
        results: [attack({ severity: "low", vulnerable: false })],
        summary: {
          resistance_rate: 1.0,
          vulnerabilities_found: 0,
          evaluated_attacks: 1,
          token_usage_total: { total_tokens: 1, cost_usd: 0.001 },
          by_severity: {},
        },
      });
    }
    const ov = await redteamOverview([rt, sim], { page: 1, perPage: 25 });
    expect(ov.recent).toHaveLength(20);
  });

  test("landing spend total cost and by kind", async () => {
    const { rt, sim } = await tmpRoots("rtspend");
    await writeJson(join(rt, "p.json"), {
      pipeline: { mode: "adaptive" },
      created_at: "2026-06-29T10:00:00",
      run_name: "P",
      total_results: 1,
      results: [attack({ severity: "low", vulnerable: false })],
      summary: {
        resistance_rate: 1.0,
        vulnerabilities_found: 0,
        evaluated_attacks: 1,
        token_usage_total: { total_tokens: 1, cost_usd: 0.005 },
        by_severity: {},
      },
    });
    await writeJson(join(sim, "s.json"), {
      mode: "run",
      created_at: "2026-06-30T10:00:00",
      run_name: "S",
      total_results: 1,
      scorer_averages: {},
      results: [
        {
          token_usage: { total_tokens: 100, cost_usd: 0.003 },
          goal_achieved: true,
          turn_count: 1,
        },
      ],
    });
    const data = await landing([rt, sim]);
    close(data.totalCost as number, 0.008);
    const byKind = Object.fromEntries(data.costByKind);
    close(byKind["Red team"] as number, 0.005);
    close(byKind["Agent sim"] as number, 0.003);
  });

  test("avg cost from cost_usd", async () => {
    const { rt, sim } = await tmpRoots("rtavg");
    await writeJson(join(sim, "s.json"), {
      mode: "run",
      created_at: "2026-06-30T10:00:00",
      run_name: "S",
      total_results: 2,
      scorer_averages: {},
      results: [
        {
          token_usage: { total_tokens: 100, cost_usd: 0.004 },
          goal_achieved: true,
          turn_count: 1,
          metadata: { scenario: "a", persona: "x" },
        },
        {
          token_usage: { total_tokens: 200, cost_usd: 0.006 },
          goal_achieved: false,
          turn_count: 2,
          metadata: { scenario: "b", persona: "y" },
        },
      ],
    });
    const ov = await simOverview([rt, sim]);
    close(ov.avgCost as number, 0.005);
  });

  test("avg cost ignores costless sims", async () => {
    const { rt, sim } = await tmpRoots("rtavgless");
    await writeJson(join(sim, "s.json"), {
      mode: "run",
      created_at: "2026-06-30T10:00:00",
      run_name: "S",
      total_results: 2,
      scorer_averages: {},
      results: [
        {
          token_usage: { total_tokens: 100, cost_usd: 0.006 },
          goal_achieved: true,
          turn_count: 1,
        },
        {
          token_usage: { total_tokens: 200 },
          goal_achieved: false,
          turn_count: 2,
        },
      ],
    });
    const ov = await simOverview([rt, sim]);
    close(ov.avgCost as number, 0.006);
  });

  test("overview row has no score for a zero-evaluated run", async () => {
    const { rt, sim } = await tmpRoots("rtzero");
    await writeJson(join(rt, "empty_20260731_130000.json"), {
      pipeline: { mode: "adaptive" },
      created_at: "2026-07-31T13:00:00",
      run_name: "Empty run",
      total_results: 1,
      results: [attack({ severity: "low", vulnerable: false, error: true })],
      summary: {
        resistance_rate: 1.0,
        vulnerabilities_found: 0,
        evaluated_attacks: 0,
        token_usage_total: { total_tokens: 1, cost_usd: 0.0 },
        by_severity: {},
      },
    });
    const ov = await redteamOverview([rt, sim]);
    expect(ov.recent).toHaveLength(1);
    expect(ov.recent[0]?.score).toBeNull();
  });

  test("evaluation crash is dropped from overview counts", async () => {
    const { rt } = await tmpRoots("rtcrash");
    const results = [
      {
        ...attack({ severity: "low", vulnerable: false }),
        evaluation: { passed: true },
      },
      {
        ...attack({ severity: "critical", vulnerable: true }),
        evaluation: { passed: false },
      },
      {
        ...attack({ severity: "high", vulnerable: false }),
        evaluation: { passed: null },
      },
    ];
    await writeJson(join(rt, "crash_20260101_000000.json"), {
      pipeline: { mode: "adaptive" },
      created_at: "2026-01-01T00:00:00",
      run_name: "Judge crash",
      total_results: results.length,
      results,
      summary: {
        resistance_rate: 1.0,
        vulnerabilities_found: 1,
        evaluated_attacks: 2,
        token_usage_total: { total_tokens: 1, cost_usd: 0.001 },
        by_severity: {},
      },
    });
    const ov = await redteamOverview([rt]);
    expect(ov.attacksRun).toBe(3);
    close(ov.breakRate as number, 1 / 2);
    close(ov.avgRobustness as number, 1 / 2);
    expect(ov.criticalFindings).toBe(1);
  });

  test("result outcome rules", () => {
    expect(resultOutcome({ evaluation: { passed: true } })).toBe(true);
    expect(resultOutcome({ evaluation: { passed: false } })).toBe(false);
    expect(resultOutcome({ evaluation: { passed: null } })).toBeNull();
    expect(resultOutcome({ evaluation: null, vulnerable: false })).toBeNull();
    expect(resultOutcome({ error: "boom", vulnerable: false })).toBeNull();
    expect(resultOutcome({ vulnerable: true })).toBe(false);
    expect(resultOutcome({ vulnerable: false })).toBe(true);
    expect(resultOutcome({})).toBeNull();
    expect(resultOutcome({ attack: { severity: "low" } })).toBeNull();
  });

  test("aggregate fills vulnerable and evaluated", async () => {
    const { rt } = await tmpRoots("rtfill");
    await writeJson(join(rt, "p.json"), {
      pipeline: { mode: "adaptive" },
      created_at: "2026-06-29T10:00:00",
      run_name: "P",
      total_results: 2,
      results: [
        attack({ severity: "low", vulnerable: true }),
        attack({ severity: "low", vulnerable: false }),
      ],
      summary: {
        resistance_rate: 0.5,
        vulnerabilities_found: 1,
        evaluated_attacks: 2,
        token_usage_total: { total_tokens: 1, cost_usd: 0.001 },
        by_severity: {},
      },
    });
    const [run] = await redteamOverview([rt]).then((ov) => ov.recent);
    expect([run?.vulnerable, run?.evaluated]).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// pairwise
// ---------------------------------------------------------------------------

describe("pairwise", () => {
  test("pairwise score is the decided share", async () => {
    const { dir } = await tmpRoots("pw");
    const runsDir = join(dir, "pairwise-runs");
    await mkdir(runsDir);
    await writeJson(join(runsDir, "run.json"), {
      judging: "pairwise",
      created_at: "2026-10-24T10:00:00",
      run_name: "v2 vs v3",
      label_a: "prompt-v2",
      label_b: "prompt-v3",
      report: { inconclusive_rate: 0.25 },
      entries: [{}, {}, {}, {}],
    });
    const [row] = await runRows([runsDir]);
    expect(row?.surface).toBe("pairwise");
    close(row?.score as number, 0.75);
  });

  test("landing omits a kind with no runs", async () => {
    const { dir } = await tmpRoots("pwland");
    const runsDir = join(dir, "pairwise-runs");
    await mkdir(runsDir);
    await writeJson(join(runsDir, "run.json"), {
      judging: "pairwise",
      created_at: "2026-10-24T10:00:00",
      run_name: "v2 vs v3",
      report: { inconclusive_rate: 0.25 },
      entries: [{}],
    });
    const landingData = await landing([runsDir]);
    expect(landingData.byKind).toEqual([["Pairwise", 1]]);
  });
});
