import { UMAP } from "umap-js";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function finiteMatrix(
  rows: readonly (readonly number[])[],
  width?: number,
): boolean {
  const columns = width ?? rows[0]?.length ?? 0;
  return rows.every(
    (row) => row.length === columns && row.every(Number.isFinite),
  );
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0,
    aNorm = 0,
    bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number,
      y = b[i] as number;
    dot += x * y;
    aNorm += x * x;
    bNorm += y * y;
  }
  return 1 - dot / Math.sqrt(aNorm * bNorm);
}

async function fit(
  rows: readonly (readonly number[])[],
  dimensions: number,
  seed: number,
  cosine: boolean,
): Promise<number[][] | null> {
  try {
    const model = new UMAP({
      nComponents: dimensions,
      nNeighbors: Math.min(15, rows.length - 1),
      random: seededRandom(seed),
      ...(cosine ? { distanceFn: cosineDistance } : {}),
    });
    const result = await model.fitAsync(rows.map((row) => [...row]));
    return result.length === rows.length && finiteMatrix(result, dimensions)
      ? result
      : null;
  } catch {
    return null;
  }
}

export async function reduce3d(
  vectors: readonly (readonly number[])[],
  randomState = 42,
): Promise<number[][] | null> {
  if (
    vectors.length < 5 ||
    !finiteMatrix(vectors) ||
    vectors.some((row) => row.every((value) => value === 0))
  )
    return null;
  const first = vectors[0] as readonly number[];
  if (
    vectors.every((row) =>
      row.every(
        (value, index) =>
          Math.abs(value - (first[index] as number)) <=
          1e-8 + 1e-5 * Math.abs(first[index] as number),
      ),
    )
  )
    return null;
  return fit(vectors, 3, randomState, true);
}

export async function project2d(
  coordinates: readonly (readonly number[])[],
  randomState = 7,
): Promise<number[][] | null> {
  if (coordinates.length < 5 || !finiteMatrix(coordinates, 3)) return null;
  return fit(coordinates, 2, randomState, false);
}
