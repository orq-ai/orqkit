import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { fromPythonKeys, toPythonKeys } from "./common/python-json.js";
import { getStoreDir } from "./common/run-store-dir.js";
import { UsageSchema } from "./contracts.js";
import {
  buildReport,
  type PairwiseAggregation,
  type PairwiseComparison,
  PairwiseComparisonSchema,
  type PairwiseReport,
  PairwiseReportSchema,
} from "./pairwise.js";

export const PairwiseResponseMetricsSchema = z.object({
  usage: UsageSchema.nullable().default(null),
  latencyMs: z.number().finite().nonnegative().nullable().default(null),
});

export type PairwiseResponseMetrics = z.infer<
  typeof PairwiseResponseMetricsSchema
>;
export type PairwiseResponseMetricsInput = z.input<
  typeof PairwiseResponseMetricsSchema
>;

export const PairwiseEntrySchema = z.object({
  question: z.string(),
  responseA: z.string(),
  responseB: z.string(),
  comparison: PairwiseComparisonSchema,
  metricsA: PairwiseResponseMetricsSchema.nullable().default(null),
  metricsB: PairwiseResponseMetricsSchema.nullable().default(null),
});

export type PairwiseEntry = z.infer<typeof PairwiseEntrySchema>;

const PairwiseRunSchema = z.object({
  judging: z.literal("pairwise").default("pairwise"),
  runName: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  labelA: z.string().default("A"),
  labelB: z.string().default("B"),
  judges: z.array(z.string()).default(() => []),
  criteria: z.string().default(""),
  // Without this a single-ordering run reads as a panel with no position bias.
  swap: z.boolean().default(true),
  entries: z.array(PairwiseEntrySchema).default(() => []),
  report: PairwiseReportSchema.nullable().default(null),
});

type PairwiseRunData = z.infer<typeof PairwiseRunSchema>;

export function getPairwiseRunsDir(): string {
  return getStoreDir("pairwise-runs");
}

function validateAggregation(aggregation: string): void {
  if (aggregation !== "plurality" && aggregation !== "bt-sigma") {
    throw new Error(
      `unknown aggregation '${aggregation}'; expected 'plurality' or 'bt-sigma'`,
    );
  }
}

function slug(text: string): string {
  const cleaned = [...text.toLowerCase()]
    .map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : "-"))
    .join("");
  const joined = cleaned.split("-").filter(Boolean).join("-");
  // Clamped on bytes because save runs after the judging is paid for, and a
  // long name must not lose a completed run to ENAMETOOLONG.
  const clamped = new TextDecoder()
    .decode(new TextEncoder().encode(joined).slice(0, 64))
    .replace(/�+$/u, "");
  return clamped.replace(/-+$/, "") || "run";
}

function timestamp(iso: string): string {
  const date = new Date(iso).toISOString();
  return `${date.slice(0, 10).replaceAll("-", "")}_${date.slice(11, 19).replaceAll(":", "")}`;
}

function annotateBtSigmaScope(
  report: PairwiseReport,
  entries: readonly PairwiseEntry[],
): PairwiseReport {
  const block = report.btSigma;
  if (!block) {
    return report;
  }
  const pairs = new Set(
    entries.map((e) => JSON.stringify([e.question, e.responseA, e.responseB])),
  );
  if (pairs.size > 1) {
    const warning = `run contains ${pairs.size} distinct question/response pairs; judge sigma measures global agreement across tasks, not isolated judge variance`;
    if (!block.fitWarnings.includes(warning)) {
      block.fitWarnings.push(warning);
    }
  }
  return report;
}

export class PairwiseRun implements PairwiseRunData {
  judging = "pairwise" as const;
  runName: string;
  createdAt: string;
  labelA: string;
  labelB: string;
  judges: string[];
  criteria: string;
  swap: boolean;
  entries: PairwiseEntry[];
  report: PairwiseReport | null;

  constructor(data: z.input<typeof PairwiseRunSchema>) {
    const parsed = PairwiseRunSchema.parse(data);
    this.runName = parsed.runName;
    this.createdAt = parsed.createdAt;
    this.labelA = parsed.labelA;
    this.labelB = parsed.labelB;
    this.judges = parsed.judges;
    this.criteria = parsed.criteria;
    this.swap = parsed.swap;
    this.entries = parsed.entries;
    this.report = parsed.report;
  }

  add(
    comparison: PairwiseComparison,
    inputs: {
      question: string;
      responseA: string;
      responseB: string;
      metricsA?: PairwiseResponseMetricsInput | null;
      metricsB?: PairwiseResponseMetricsInput | null;
    },
  ): void {
    this.entries.push(PairwiseEntrySchema.parse({ ...inputs, comparison }));
  }

  comparisons(): PairwiseComparison[] {
    return this.entries.map((e) => e.comparison);
  }

  rollup(aggregation: PairwiseAggregation = "plurality"): PairwiseReport {
    validateAggregation(aggregation);
    if (this.report && (aggregation === "plurality" || this.report.btSigma)) {
      return annotateBtSigmaScope(this.report, this.entries);
    }
    return annotateBtSigmaScope(
      buildReport(this.comparisons(), aggregation),
      this.entries,
    );
  }

  async save(
    path?: string | null,
    aggregation: PairwiseAggregation = "plurality",
  ): Promise<string> {
    validateAggregation(aggregation);
    this.report = annotateBtSigmaScope(
      buildReport(this.comparisons(), aggregation),
      this.entries,
    );
    const payload = JSON.stringify(toPythonKeys(this, "PairwiseRun"), null, 2);
    if (path) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, payload, "utf-8");
      return path;
    }

    const runsDir = getPairwiseRunsDir();
    await mkdir(runsDir, { recursive: true });
    const base = `${timestamp(this.createdAt)}_${slug(this.runName)}`;
    let target = join(runsDir, `${base}.json`);
    // Exclusive-create: the stamp only resolves to the second, so two runs of
    // the same name would otherwise overwrite each other.
    for (let counter = 1; counter <= 1000; counter++) {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(target, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        target = join(
          runsDir,
          `${base}_${String(counter).padStart(3, "0")}.json`,
        );
        continue;
      }
      try {
        await handle.writeFile(payload, "utf-8");
        return target;
      } catch (error) {
        await rm(target, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
    }
    throw new Error(
      `could not find a free filename for ${base} after 1000 attempts`,
    );
  }

  static async load(path: string): Promise<PairwiseRun> {
    return new PairwiseRun(
      fromPythonKeys(
        JSON.parse(await readFile(path, "utf-8")),
        "PairwiseRun",
      ) as z.input<typeof PairwiseRunSchema>,
    );
  }
}

export function newRun(options: {
  runName: string;
  labelA?: string;
  labelB?: string;
  judges?: readonly string[];
  criteria?: string;
  swap?: boolean;
}): PairwiseRun {
  return new PairwiseRun({
    ...options,
    judges: [...(options.judges ?? [])],
    createdAt: new Date().toISOString(),
  });
}
