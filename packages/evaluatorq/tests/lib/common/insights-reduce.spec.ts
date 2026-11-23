import { describe, expect, it, spyOn } from "bun:test";

import { UMAP } from "umap-js";

import { project2d, reduce3d } from "../../../src/lib/insights/reduce.js";

describe("Insights map reduction", () => {
  const vectors = Array.from({ length: 8 }, (_, i) => [
    1 + i,
    1 + ((i * i) % 7),
    2 + (i % 3),
    1 + (i % 2),
  ]);

  it("rejects invalid or degenerate 3D inputs", async () => {
    expect(await reduce3d(vectors.slice(0, 4))).toBeNull();
    expect(await reduce3d(Array.from({ length: 5 }, () => [1, 2]))).toBeNull();
    expect(
      await reduce3d([[0, 0], ...vectors.slice(0, 4).map(() => [1, 2])]),
    ).toBeNull();
    expect(
      await reduce3d([[NaN, 1], ...vectors.slice(0, 4).map(() => [1, 2])]),
    ).toBeNull();
    expect(
      await reduce3d([[1], ...vectors.slice(0, 4).map(() => [1, 2])]),
    ).toBeNull();
  });

  it("returns deterministic finite coordinates in both dimensions", async () => {
    const a = await reduce3d(vectors);
    expect(a).not.toBeNull();
    if (!a) throw new Error("Reduction failed");
    expect(await reduce3d(vectors)).toEqual(a);
    expect(
      a?.every((row) => row.length === 3 && row.every(Number.isFinite)),
    ).toBe(true);
    const b = await project2d(a);
    expect(b?.length).toBe(vectors.length);
    expect(
      b?.every((row) => row.length === 2 && row.every(Number.isFinite)),
    ).toBe(true);
    expect(await project2d(a)).toEqual(b);
  }, 15000);

  it("rejects invalid 2D projection inputs", async () => {
    expect(await project2d(vectors.slice(0, 4))).toBeNull();
    expect(await project2d(vectors)).toBeNull();
    expect(
      await project2d(Array.from({ length: 5 }, () => [1, Infinity, 3])),
    ).toBeNull();
  });

  it("reports unexpected UMAP failures without changing the nullable result", async () => {
    const fit = spyOn(UMAP.prototype, "fitAsync").mockRejectedValue(
      new Error("synthetic layout failure"),
    );
    const errors: string[] = [];
    try {
      expect(
        await reduce3d(vectors, 42, (error) => errors.push(error)),
      ).toBeNull();
      expect(
        await project2d(
          vectors.map((row) => row.slice(0, 3)),
          7,
          (error) => errors.push(error),
        ),
      ).toBeNull();
      expect(errors).toEqual([
        "synthetic layout failure",
        "synthetic layout failure",
      ]);
      expect(
        await reduce3d(vectors.slice(0, 4), 42, (error) => errors.push(error)),
      ).toBeNull();
      expect(errors).toHaveLength(2);
    } finally {
      fit.mockRestore();
    }
  });

  it("reports invalid coordinates returned by UMAP", async () => {
    const fit = spyOn(UMAP.prototype, "fitAsync").mockResolvedValue([
      [NaN, 0, 0],
    ]);
    const errors: string[] = [];
    try {
      expect(
        await reduce3d(vectors, 42, (error) => errors.push(error)),
      ).toBeNull();
      expect(errors).toEqual(["UMAP returned invalid coordinates"]);
    } finally {
      fit.mockRestore();
    }
  });
});
