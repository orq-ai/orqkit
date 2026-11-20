import type { InsightsRunFields, TraceInsight } from "../insights/models.js";

type Point = [number, number];
type Run = Pick<InsightsRunFields, "traces">;

/** The shared map and review-payload key for one trace span. */
export function reviewTraceKey(
  trace: Pick<TraceInsight, "traceId" | "spanId">,
): string {
  return `${trace.traceId}:${trace.spanId ?? ""}`;
}

function finiteNumbers(values: unknown): number[] | null {
  if (!Array.isArray(values)) return null;
  const numbers = values.map((value) =>
    typeof value === "number" ? value : Number.NaN,
  );
  return numbers.every(Number.isFinite) ? numbers : null;
}

function finitePair(values: unknown): Point | null {
  const numbers = finiteNumbers(values);
  return numbers?.length === 2
    ? [numbers[0] as number, numbers[1] as number]
    : null;
}

const noSaved2d = (run: Run) =>
  run.traces.every((trace) => trace.coords2d === null);

function skipped(trace: TraceInsight, dimension: string): void {
  console.warn(
    `Insights review map skipped invalid coordinates for ${trace.traceId} in dimension ${dimension}`,
  );
}

function legacyXy(run: Run, dimension: string): Map<string, Point> {
  const points = new Map<string, Point>();
  for (const trace of run.traces) {
    const coords = trace.coords[dimension];
    if (coords === undefined) continue;
    const numbers = finiteNumbers(coords);
    if (numbers?.length === 3)
      points.set(reviewTraceKey(trace), [
        numbers[0] as number,
        numbers[1] as number,
      ]);
    else skipped(trace, dimension);
  }
  return points;
}

/** Read saved finite 2D coordinates, with an announced 3D fallback for legacy reports. */
export function reviewXy(run: Run, dimension: string): Map<string, Point> {
  let points: Map<string, Point>;
  if (noSaved2d(run)) {
    console.warn(
      `Insights review map is using the legacy report 3D XY fallback for dimension ${dimension}`,
    );
    points = legacyXy(run, dimension);
  } else {
    points = new Map();
    for (const trace of run.traces) {
      const coords2d = trace.coords2d ?? {};
      if (!Object.hasOwn(coords2d, dimension)) continue;
      const pair = finitePair(coords2d[dimension]);
      if (pair === null) {
        skipped(trace, dimension);
        continue;
      }
      points.set(reviewTraceKey(trace), pair);
    }
  }
  if (points.size < 5) {
    console.warn(
      `Insights review map unavailable for dimension ${dimension}: only ${points.size} valid points (need >= 5)`,
    );
    return new Map();
  }
  return points;
}

export interface ReviewXyState {
  available: boolean;
  reason: string | null;
  n_points: number;
}

/** Explicit availability metadata for saved review-map coordinates. */
export function reviewXyState(
  run: Run,
  dimension: string,
  xy: Map<string, Point> = reviewXy(run, dimension),
): ReviewXyState {
  if (xy.size > 0) return { available: true, reason: null, n_points: xy.size };
  const legacy = noSaved2d(run);
  const nValid = legacy
    ? legacyXy(run, dimension).size
    : new Set(
        run.traces
          .filter((trace) => {
            const coords2d = trace.coords2d ?? {};
            return (
              Object.hasOwn(coords2d, dimension) &&
              finitePair(coords2d[dimension]) !== null
            );
          })
          .map(reviewTraceKey),
      ).size;
  const hasSavedDimension = run.traces.some((trace) =>
    Object.hasOwn(trace.coords2d ?? {}, dimension),
  );
  const reason =
    !hasSavedDimension && !legacy
      ? "Saved 2D coordinates are unavailable for this dimension."
      : nValid < 5
        ? `Only ${nValid} valid points are available; at least 5 are needed.`
        : "Saved 2D coordinates are unavailable for this dimension.";
  return { available: false, reason, n_points: nValid };
}
