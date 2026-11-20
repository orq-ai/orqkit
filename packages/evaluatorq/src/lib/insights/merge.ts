import type OpenAI from "openai";

import { ClassifyQuestionSchema } from "../common/judge.js";
import { checkRunActive, withRunLifecycle } from "../common/run-lifecycle.js";
import { LLMCallConfig } from "../contracts.js";
import type { ClusterName } from "./describe.js";
import { classifyWithRetry } from "./labeling.js";
import type { UsageLedger } from "./usage.js";

export interface MergeResult {
  representatives: Record<number, number>;
  nPairs: number;
  nFailed: number;
}

export function candidatePairs(
  names: Readonly<Record<number, ClusterName>>,
  neighbours: Readonly<Record<number, readonly number[]>>,
): [number, number][] {
  const seen = new Set<string>(),
    pairs: [number, number][] = [];
  for (const id of Object.keys(names)
    .map(Number)
    .sort((a, b) => a - b)) {
    for (const other of neighbours[id] ?? []) {
      if (id === other || !Object.hasOwn(names, other)) continue;
      const a = Math.min(id, other),
        b = Math.max(id, other),
        key = `${a}:${b}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

export async function mergeSimilar(
  names: Readonly<Record<number, ClusterName>>,
  examples: Readonly<Record<number, readonly string[]>>,
  neighbours: Readonly<Record<number, readonly number[]>>,
  options: {
    client: OpenAI;
    model: string;
    threshold?: number;
    parallelism?: number;
    usage?: UsageLedger;
    signal?: AbortSignal;
  },
): Promise<MergeResult> {
  const threshold = options.threshold ?? 0.7,
    parallelism = options.parallelism ?? 20;
  if (!Number.isInteger(parallelism) || parallelism < 1)
    throw new RangeError("parallelism must be positive");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new RangeError("threshold must be finite and between 0 and 1");
  const ids = Object.keys(names).map(Number),
    parent = new Map(ids.map((id) => [id, id]));
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    while (parent.get(id) !== root) {
      const next = parent.get(id) as number;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const pairs = candidatePairs(names, neighbours),
    cfg = new LLMCallConfig({ model: options.model, timeoutMs: 90000 });
  let next = 0,
    failed = 0;
  return withRunLifecycle(
    parallelism,
    async () => {
      const worker = async () => {
        while (next < pairs.length) {
          checkRunActive();
          const [a, b] = pairs[next++] as [number, number];
          try {
            const state = {
              cluster_a: {
                ...names[a],
                examples: (examples[a] ?? []).slice(0, 3),
              },
              cluster_b: {
                ...names[b],
                examples: (examples[b] ?? []).slice(0, 3),
              },
            };
            const question = ClassifyQuestionSchema.parse({
              kind: "noul",
              instructions:
                "Do these two clusters describe the same specific activity on the same kind of object, so that a reader would lose nothing if they were one cluster? Clusters that share a broad area but differ in what was done (for example writing tickets versus reviewing pull requests) are not the same.",
              state,
            });
            const outcome = await classifyWithRetry({
              client: options.client,
              model: options.model,
              cfg,
              request: { state, questions: { same: question } },
              usage: options.usage?.scoped("merge"),
              signal: options.signal,
            });
            checkRunActive();
            const answer = outcome.response?.answers.same;
            if (
              outcome.errorKind !== null ||
              !answer ||
              answer.type !== "noul" ||
              answer.noul === null ||
              !Number.isFinite(answer.noul)
            ) {
              failed++;
              continue;
            }
            if (answer.noul >= threshold) {
              const left = find(a),
                right = find(b);
              if (left !== right)
                parent.set(Math.max(left, right), Math.min(left, right));
            }
          } catch (error) {
            checkRunActive();
            failed++;
            console.warn(
              `Insights merge failed for clusters ${a} and ${b}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(parallelism, pairs.length) }, worker),
      );
      const failure = settled.find((item) => item.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return {
        representatives: Object.fromEntries(ids.map((id) => [id, find(id)])),
        nPairs: pairs.length,
        nFailed: failed,
      };
    },
    options.signal,
  );
}
