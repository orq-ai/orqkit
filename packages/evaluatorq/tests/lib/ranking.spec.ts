import { describe, expect, spyOn, test } from "bun:test";

import {
  binarize,
  comparisonsPerJudge,
  cycleRate,
  fitBt,
  type JudgedComparison,
  reliability,
} from "../../src/lib/ranking.js";

const vote = (
  judge: string,
  itemA: string,
  itemB: string,
  pA: number,
  weight = 1,
): JudgedComparison => ({ judge, itemA, itemB, pA, weight });

describe("fitBt", () => {
  test("rejects empty input and out of range preferences", () => {
    expect(() => fitBt([])).toThrow("at least one");
    expect(() => fitBt([vote("j", "a", "b", 1.5)])).toThrow();
    expect(() => fitBt([vote("j", "a", "b", 1, 0)])).toThrow();
  });

  test("ranks a transitive order and centres skills", () => {
    const fit = fitBt(
      [
        vote("j", "a", "b", 1, 5),
        vote("j", "b", "c", 1, 5),
        vote("j", "a", "c", 1, 5),
      ],
      { judgeSigma: false },
    );
    expect(fit.ranking).toEqual(["a", "b", "c"]);
    expect(fit.sigmas).toEqual({});
    const sum = Object.values(fit.skills).reduce((x, y) => x + y, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-9);
  });

  test("a noisy judge gets a larger sigma than a consistent one", () => {
    const comparisons = [
      vote("sharp", "a", "b", 1, 5),
      vote("sharp", "b", "c", 1, 5),
      vote("sharp", "a", "c", 1, 5),
      vote("noisy", "a", "b", 0.6, 5),
      vote("noisy", "b", "c", 0.4, 5),
      vote("noisy", "a", "c", 0.55, 5),
    ];
    const fit = fitBt(comparisons);
    expect(fit.ranking[0]).toBe("a");
    expect(reliability(fit, "sharp")).toBeGreaterThan(
      reliability(fit, "noisy"),
    );
  });

  test("weights match repeated records", () => {
    const repeated = Array.from({ length: 4 }, () => vote("j", "a", "b", 0.8));
    const a = fitBt(repeated, { judgeSigma: false });
    const b = fitBt([vote("j", "a", "b", 0.8, 4)], { judgeSigma: false });
    expect(a.skills.a).toBeCloseTo(b.skills.a as number, 6);
  });

  test("a single judge falls back to plain BT with a warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const fit = fitBt([vote("j", "a", "b", 1, 3)]);
    warn.mockRestore();
    expect(fit.sigmas).toEqual({});
    expect(fit.warnings.join()).toContain("single judge");
  });

  test("warns on sparse judges and disconnected graphs", () => {
    const fit = fitBt([vote("j1", "a", "b", 1), vote("j2", "c", "d", 1)], {
      judgeSigma: false,
    });
    expect(fit.warnings.join()).toContain("j1, j2");
    expect(fit.warnings.join()).toContain("2 components");
  });

  test("perfectly ambiguous data stays symmetric", () => {
    const fit = fitBt([vote("x", "a", "b", 1, 3), vote("y", "a", "b", 0, 3)]);
    expect(fit.converged).toBe(true);
    expect(fit.skills.a).toBeCloseTo(0, 6);
    expect(fit.sigmas.x).toBeCloseTo(fit.sigmas.y as number, 6);
  });
});

describe("helpers", () => {
  test("binarize keeps exact ties", () => {
    expect(
      binarize([
        vote("j", "a", "b", 0.7),
        vote("j", "a", "b", 0.5),
        vote("j", "a", "b", 0.2),
      ]).map((c) => c.pA),
    ).toEqual([1, 0.5, 0]);
  });

  test("comparisonsPerJudge sums weights", () => {
    expect(
      comparisonsPerJudge([vote("x", "a", "b", 1, 2), vote("x", "a", "c", 1)]),
    ).toEqual({ x: 3 });
  });

  test("cycleRate finds a 3-cycle and ignores other judges", () => {
    const cycle = [
      vote("j", "a", "b", 1),
      vote("j", "b", "c", 1),
      vote("j", "c", "a", 1),
      vote("other", "a", "b", 0),
    ];
    expect(cycleRate(cycle, "j")).toBe(1);
  });

  test("cycleRate is 0 for a transitive judge", () => {
    expect(
      cycleRate(
        [
          vote("j", "a", "b", 1),
          vote("j", "b", "c", 1),
          vote("j", "a", "c", 1),
        ],
        "j",
      ),
    ).toBe(0);
  });

  test("cycleRate treats a split pair as no preference", () => {
    expect(
      cycleRate(
        [
          vote("j", "a", "b", 1),
          vote("j", "b", "a", 1),
          vote("j", "b", "c", 1),
          vote("j", "c", "a", 1),
        ],
        "j",
      ),
    ).toBeUndefined();
  });
});
