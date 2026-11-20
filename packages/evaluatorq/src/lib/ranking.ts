import { z } from "zod";

const LR = 0.1;
const LR_DECAY_STEPS = 200;
const MAX_ITER = 20_000;
// Convergence is measured on the iterate: the ridge leaves a radial gradient
// that the mean-centring undoes every step, so the raw gradient never reaches 0.
const TOL = 1e-4;
// One small step is not convergence: Adam can stall briefly when its momentum
// flips sign crossing the optimum.
const TOL_STREAK = 5;
const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;
const RIDGE = 1e-2;
const TAU_RIDGE = 1e-2;
const P_EPS = 1e-6;
// Without this floor Adam's scale invariance turns float dust at a symmetric
// stationary point into a full step, and perfectly ambiguous data gets an
// arbitrary winner.
const GRAD_FLOOR = 1e-10;
const MIN_JUDGE_COMPARISONS = 3;

export const JudgedComparisonSchema = z.object({
  judge: z.string(),
  itemA: z.string(),
  itemB: z.string(),
  pA: z.number().min(0).max(1),
  weight: z.number().positive().default(1),
});

export type JudgedComparison = z.output<typeof JudgedComparisonSchema>;
export type JudgedComparisonInput = z.input<typeof JudgedComparisonSchema>;

export interface BTFit {
  skills: Record<string, number>;
  /** Only ratios within one fit are meaningful. Empty without judge sigma. */
  sigmas: Record<string, number>;
  ranking: string[];
  converged: boolean;
  iterations: number;
  warnings: string[];
}

export function reliability(fit: BTFit, judge: string): number {
  const sigma = fit.sigmas[judge];
  if (sigma === undefined) {
    throw new Error(`No sigma for judge "${judge}"`);
  }
  return 1 / sigma;
}

function logistic(x: number): number {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-Math.min(x, 60)));
  }
  const z = Math.exp(Math.max(x, -60));
  return z / (1 + z);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function binarize(
  comparisons: readonly JudgedComparison[],
): JudgedComparison[] {
  return comparisons.map((c) => ({
    ...c,
    pA: c.pA === 0.5 ? 0.5 : c.pA > 0.5 ? 1 : 0,
  }));
}

export function comparisonsPerJudge(
  comparisons: readonly Pick<JudgedComparison, "judge" | "weight">[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of comparisons) {
    counts[c.judge] = (counts[c.judge] ?? 0) + c.weight;
  }
  return counts;
}

function countComponents(
  comparisons: readonly JudgedComparison[],
  items: readonly string[],
): number {
  const adjacency = new Map<string, Set<string>>(
    items.map((item) => [item, new Set<string>()]),
  );
  for (const c of comparisons) {
    adjacency.get(c.itemA)?.add(c.itemB);
    adjacency.get(c.itemB)?.add(c.itemA);
  }
  const unseen = new Set(items);
  let components = 0;
  for (const start of items) {
    if (!unseen.delete(start)) {
      continue;
    }
    components += 1;
    const stack = [start];
    while (stack.length > 0) {
      for (const neighbor of adjacency.get(stack.pop() as string) ?? []) {
        if (unseen.delete(neighbor)) {
          stack.push(neighbor);
        }
      }
    }
  }
  return components;
}

interface AdamState {
  m: number[];
  v: number[];
}

function adamStep(
  values: number[],
  gradients: readonly number[],
  state: AdamState,
  step: number,
  lr: number,
): void {
  for (let i = 0; i < values.length; i += 1) {
    const g = gradients[i] as number;
    const m = ADAM_B1 * (state.m[i] as number) + (1 - ADAM_B1) * g;
    const v = ADAM_B2 * (state.v[i] as number) + (1 - ADAM_B2) * g * g;
    state.m[i] = m;
    state.v[i] = v;
    const mHat = m / (1 - ADAM_B1 ** step);
    const vHat = v / (1 - ADAM_B2 ** step);
    values[i] =
      (values[i] as number) + (lr * mHat) / (Math.sqrt(vHat) + ADAM_EPS);
  }
}

function maxAbs(values: readonly number[]): number {
  return values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function iterate(
  comparisons: readonly JudgedComparison[],
  items: readonly string[],
  judges: readonly string[],
  useSigma: boolean,
) {
  const itemIndex = new Map(items.map((item, i) => [item, i]));
  const judgeIndex = new Map(judges.map((judge, i) => [judge, i]));
  const records = comparisons.map((c) => ({
    a: itemIndex.get(c.itemA) as number,
    b: itemIndex.get(c.itemB) as number,
    k: judgeIndex.get(c.judge) as number,
    p: Math.min(Math.max(c.pA, P_EPS), 1 - P_EPS),
    weight: c.weight,
  }));
  const zeros = (n: number) => new Array<number>(n).fill(0);
  const s = zeros(items.length);
  const tau = zeros(judges.length);
  const adamS = { m: zeros(items.length), v: zeros(items.length) };
  const adamT = { m: zeros(judges.length), v: zeros(judges.length) };

  let iterations = 0;
  let converged = false;
  let delta = Number.POSITIVE_INFINITY;
  let stillStreak = 0;

  for (let step = 1; step <= MAX_ITER; step += 1) {
    iterations = step;
    const gS = zeros(items.length);
    const gT = zeros(judges.length);
    for (const { a, b, k, p, weight } of records) {
      const sigma = useSigma ? Math.exp(tau[k] as number) : 1;
      const z = ((s[a] as number) - (s[b] as number)) / sigma;
      const err = (p - logistic(z)) * weight;
      gS[a] = (gS[a] as number) + err / sigma;
      gS[b] = (gS[b] as number) - err / sigma;
      if (useSigma) {
        gT[k] = (gT[k] as number) - err * z;
      }
    }
    for (let i = 0; i < s.length; i += 1) {
      gS[i] = (gS[i] as number) - RIDGE * (s[i] as number);
    }
    if (useSigma) {
      for (let k = 0; k < tau.length; k += 1) {
        gT[k] = (gT[k] as number) - TAU_RIDGE * (tau[k] as number);
      }
    }

    const maxGradient = useSigma
      ? Math.max(maxAbs(gS), maxAbs(gT))
      : maxAbs(gS);
    if (maxGradient < GRAD_FLOOR) {
      converged = true;
      break;
    }

    const lr = LR / (1 + step / LR_DECAY_STEPS);
    const prevS = [...s];
    const prevTau = [...tau];
    adamStep(s, gS, adamS, step, lr);
    if (useSigma) {
      adamStep(tau, gT, adamT, step, lr);
    }

    const mean = s.reduce((sum, value) => sum + value, 0) / s.length;
    for (let i = 0; i < s.length; i += 1) {
      s[i] = (s[i] as number) - mean;
    }

    delta = maxAbs(s.map((value, i) => value - (prevS[i] as number)));
    if (useSigma) {
      delta = Math.max(
        delta,
        maxAbs(tau.map((value, k) => value - (prevTau[k] as number))),
      );
    }
    stillStreak = delta < TOL ? stillStreak + 1 : 0;
    if (stillStreak >= TOL_STREAK) {
      converged = true;
      break;
    }
  }

  return { s, tau, iterations, converged, delta };
}

export interface FitBtOptions {
  judgeSigma?: boolean;
  hard?: boolean;
}

/**
 * Fit the Bradley-Terry family by maximum likelihood (arXiv:2602.16610).
 * `judgeSigma` adds the per-judge discriminator, `hard` binarizes preferences.
 * Collapse repeated judgements with `weight` first: the cost is iterations
 * times records.
 */
export function fitBt(
  input: readonly JudgedComparisonInput[],
  { judgeSigma = true, hard = false }: FitBtOptions = {},
): BTFit {
  if (input.length === 0) {
    throw new Error("fitBt needs at least one comparison");
  }
  const parsed = input.map((c) => JudgedComparisonSchema.parse(c));
  const comparisons = hard ? binarize(parsed) : parsed;

  const items = [
    ...new Set(comparisons.flatMap((c) => [c.itemA, c.itemB])),
  ].sort(compare);
  const judges = [...new Set(comparisons.map((c) => c.judge))].sort(compare);
  const warnings: string[] = [];

  const sparse = Object.entries(comparisonsPerJudge(comparisons))
    .filter(([, count]) => count < MIN_JUDGE_COMPARISONS)
    .map(([judge]) => judge)
    .sort(compare);
  if (sparse.length > 0) {
    warnings.push(
      `judge(s) ${sparse.join(", ")} have fewer than ${MIN_JUDGE_COMPARISONS} observations; their sigma estimates are weakly supported`,
    );
  }

  const components = countComponents(comparisons, items);
  if (components > 1) {
    warnings.push(
      `comparison graph is disconnected (${components} components); relative ranks across components are not identified`,
    );
  }

  let useSigma = judgeSigma;
  if (judgeSigma && judges.length < 2) {
    useSigma = false;
    const warning =
      "single judge: sigma is unidentifiable, fitted plain BT instead";
    warnings.push(warning);
    console.warn(`fitBt: ${warning}`);
  }

  const { s, tau, iterations, converged, delta } = iterate(
    comparisons,
    items,
    judges,
    useSigma,
  );

  if (!converged) {
    const warning = `fit stopped at the ${MAX_ITER}-iteration cap (max|step|=${delta.toExponential(2)})`;
    warnings.push(warning);
    console.warn(`fitBt: ${warning}`);
  }

  const skills = Object.fromEntries(
    items.map((item, i) => [item, s[i] as number]),
  );
  return {
    skills,
    sigmas: useSigma
      ? Object.fromEntries(
          judges.map((judge, k) => [judge, Math.exp(tau[k] as number)]),
        )
      : {},
    ranking: [...items].sort(
      (a, b) => (skills[b] as number) - (skills[a] as number),
    ),
    converged,
    iterations,
    warnings,
  };
}

/**
 * Directed 3-cycle rate of one judge over assessable triplets, or undefined
 * when no complete untied triplet exists. Repeats of a pair are averaged first.
 */
export function cycleRate(
  comparisons: readonly JudgedComparison[],
  judge: string,
): number | undefined {
  const totals = new Map<
    string,
    { a: string; b: string; p: number; w: number }
  >();
  for (const c of comparisons) {
    if (c.judge !== judge) {
      continue;
    }
    const [a, b, p] =
      c.itemA <= c.itemB
        ? [c.itemA, c.itemB, c.pA]
        : [c.itemB, c.itemA, 1 - c.pA];
    const key = JSON.stringify([a, b]);
    const entry = totals.get(key) ?? { a, b, p: 0, w: 0 };
    entry.p += p * c.weight;
    entry.w += c.weight;
    totals.set(key, entry);
  }

  const prefers = new Map<string, boolean>();
  const pairKey = (a: string, b: string) => JSON.stringify([a, b]);
  for (const { a, b, p, w } of totals.values()) {
    const mean = p / w;
    if (mean !== 0.5) {
      prefers.set(pairKey(a, b), mean > 0.5);
      prefers.set(pairKey(b, a), mean < 0.5);
    }
  }

  const items = [
    ...new Set(
      [...prefers.keys()].flatMap((key) => JSON.parse(key) as string[]),
    ),
  ].sort(compare);
  if (items.length < 3) {
    return undefined;
  }

  let triplets = 0;
  let cycles = 0;
  for (let x = 0; x < items.length; x += 1) {
    for (let y = x + 1; y < items.length; y += 1) {
      for (let z = y + 1; z < items.length; z += 1) {
        const [a, b, c] = [items[x], items[y], items[z]] as [
          string,
          string,
          string,
        ];
        const ab = prefers.get(pairKey(a, b));
        const bc = prefers.get(pairKey(b, c));
        const ca = prefers.get(pairKey(c, a));
        if (ab === undefined || bc === undefined || ca === undefined) {
          continue;
        }
        triplets += 1;
        if (ab === bc && bc === ca) {
          cycles += 1;
        }
      }
    }
  }
  return triplets === 0 ? undefined : cycles / triplets;
}
