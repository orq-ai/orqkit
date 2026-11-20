import { readFile } from "node:fs/promises";

import type OpenAI from "openai";

import type { Orq } from "@orq-ai/node";

import { envRaw } from "../../../common/env-config.js";
import {
  buildEvalReplacements,
  type JudgeOutcome,
  judgeErrorPayload,
  runJudge,
} from "../../../common/judge.js";
import {
  appendJurySummary,
  attachJuryRawOutput,
  panelCompositionMessages,
  runJury,
} from "../../../common/jury.js";
import { resolveOrqClient } from "../../../common/orq-client.js";
import {
  outputErrorText,
  outputToMessages,
} from "../../../common/output-adapters.js";
import type { FetchLike } from "../../../common/trace-input.js";
import { setSpanAttrs } from "../../../common/tracing.js";
import {
  EVAL_ERROR_RAW_OUTPUT_KEY,
  LLMCallConfig,
  type LLMCallConfigInput,
  LLMCallConfigSchema,
  type Usage,
} from "../../../contracts.js";
import type { DataPoint, EvaluationResult, Evaluator } from "../../../types.js";
import type { OWASPEvaluatorOptions } from "../../adaptive/evaluator.js";
import { createAsyncLlmClient } from "../../backends/client.js";
import {
  EvaluatorConfig,
  evaluatorModelFor,
  PIPELINE_CONFIG,
  RED_TEAM_TIE_OUTCOME,
} from "../../config.js";
import { normalizeCategory } from "../../contracts.js";
import { DatasetError } from "../../exceptions.js";
import { RedTeamInputSchema, StaticDatasetSchema } from "../../input.js";
import { annotateCurrentSpan, setJurySpanAttrs } from "../../tracing.js";
import { getEvaluatorForCategory } from "./evaluators.js";

export const DEFAULT_HF_REPO = "orq/redteam-vulnerabilities";
export const DEFAULT_HF_FILENAME = "redteam_dataset.v2.json";
export interface StaticDatasetOptions {
  numSamples?: number | null;
  categories?: readonly string[] | null;
  deliveryMethods?: ReadonlySet<string> | readonly string[] | null;
  orqClient?: Orq;
  fetch?: FetchLike;
  signal?: AbortSignal;
}
export function parseHfSource(rest: string): [string, string] {
  const parts = rest.split("/"),
    org = parts.shift(),
    repo = parts.shift();
  if (!org || !repo)
    throw new RangeError(
      `Invalid HuggingFace dataset specifier 'hf:${rest}'. Expected format: 'hf:org/repo' or 'hf:org/repo/filename.json'`,
    );
  return [`${org}/${repo}`, parts.join("/") || DEFAULT_HF_FILENAME];
}
export function isHuggingfaceSource(dataset?: string | null): boolean {
  return dataset == null || dataset.startsWith("hf:");
}
export function ensureHuggingfaceAvailable(): void {
  if (typeof globalThis.fetch !== "function")
    throw new Error(
      "Loading HuggingFace datasets requires a runtime with fetch support.",
    );
}
function filterByCategories<T>(
  items: T[],
  categories: readonly string[],
  categoryOf: (item: T) => string,
): T[] {
  const requested = new Set(
      categories.map((category) => normalizeCategory(category.toUpperCase())),
    ),
    present = new Set(
      items.map((item) => normalizeCategory(categoryOf(item).toUpperCase())),
    );
  const filtered = items.filter((item) =>
    requested.has(normalizeCategory(categoryOf(item).toUpperCase())),
  );
  for (const category of [...requested].sort())
    if (!present.has(category))
      console.warn(
        `Requested category ${category}: 0 static datapoints available in the dataset (it will contribute no static results).`,
      );
  return filtered;
}
const inputField = (
  inputs: Record<string, unknown>,
  camel: string,
  snake: string,
) => (Object.hasOwn(inputs, camel) ? inputs[camel] : inputs[snake]);
export function applyStaticDatasetFilters(
  data: readonly DataPoint[],
  options: StaticDatasetOptions = {},
): DataPoint[] {
  let result = [...data];
  if (options.categories != null)
    result = filterByCategories(result, options.categories, (row) =>
      String(row.inputs.category ?? ""),
    );
  if (options.deliveryMethods != null) {
    const selected = new Set(options.deliveryMethods);
    result = result.filter((row) =>
      selected.has(
        String(inputField(row.inputs, "deliveryMethod", "delivery_method")),
      ),
    );
  }
  if (options.numSamples != null && options.numSamples > 0)
    result = result.slice(0, options.numSamples);
  return result;
}
function datasetToDatapoints(
  raw: unknown,
  options: StaticDatasetOptions,
): DataPoint[] {
  const dataset = StaticDatasetSchema.parse(raw);
  let samples = dataset.samples;
  if (options.categories != null)
    samples = filterByCategories(
      samples,
      options.categories,
      (sample) => sample.input.category,
    );
  if (options.deliveryMethods != null) {
    const selected = new Set(options.deliveryMethods);
    samples = samples.filter((sample) =>
      selected.has(sample.input.deliveryMethod),
    );
  }
  if (options.numSamples != null && options.numSamples > 0)
    samples = samples.slice(0, options.numSamples);
  return samples.map((sample) => ({
    inputs: {
      ...sample.input,
      messages: sample.messages.map((message) =>
        Object.fromEntries(
          Object.entries(message).filter(([, value]) => value !== null),
        ),
      ),
    },
    expectedOutput: null,
  }));
}
export async function loadOwaspAgenticDataset(
  dataset?: string | null,
  options: StaticDatasetOptions = {},
): Promise<DataPoint[]> {
  options.signal?.throwIfAborted();
  if (isHuggingfaceSource(dataset)) {
    if (!options.fetch) ensureHuggingfaceAvailable();
    const [repo, filename] =
      dataset == null
        ? [DEFAULT_HF_REPO, DEFAULT_HF_FILENAME]
        : parseHfSource(dataset.slice(3));
    let raw: unknown;
    try {
      const token = envRaw("HF_TOKEN"),
        url = `https://huggingface.co/datasets/${repo.split("/").map(encodeURIComponent).join("/")}/resolve/main/${filename.split("/").map(encodeURIComponent).join("/")}`;
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        signal: options.signal,
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      raw = await response.json();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new DatasetError(
        `Failed to download red team dataset from HuggingFace (${repo}/${filename}): ${error instanceof Error ? error.message : String(error)}. Check your network connection, repository/file and access (HF_TOKEN for private datasets), or pass a local dataset path.`,
        { cause: error },
      );
    }
    try {
      return datasetToDatapoints(raw, options);
    } catch (error) {
      throw new DatasetError(
        `Failed to load red team dataset from HuggingFace (${repo}/${filename}): expected valid JSON in {"samples": [...]} format.`,
        { cause: error },
      );
    }
  }
  if (dataset?.startsWith("orq:")) {
    const datasetId = dataset.slice(4);
    if (!datasetId)
      throw new RangeError(
        "Invalid dataset specifier 'orq:': provide a dataset ID after the colon, e.g. 'orq:my-dataset-id'",
      );
    if (!options.orqClient && !envRaw("ORQ_API_KEY"))
      throw new Error(
        "Fetching datasets from the ORQ platform requires ORQ_API_KEY to be set. Alternatively, pass a local file path as the dataset argument.",
      );
    const client = options.orqClient ?? (await resolveOrqClient()),
      data: DataPoint[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      options.signal?.throwIfAborted();
      const response = await client.datasets.listDatapoints(
        { datasetId, limit: 100, startingAfter: cursor },
        { signal: options.signal },
      );
      for (const row of response.data) {
        const inputs = row.inputs ? { ...row.inputs } : {},
          validInput = RedTeamInputSchema.safeParse(inputs);
        if (
          !validInput.success ||
          !Array.isArray(inputs.messages) ||
          !inputs.messages.length
        ) {
          console.warn(
            `Skipping invalid datapoint ${String(inputs.id ?? "unknown")}: validation failed`,
          );
          continue;
        }
        data.push({ inputs, expectedOutput: null });
      }
      if (!response.hasMore) break;
      const last = response.data.at(-1),
        next = last?.id;
      if (!next || cursors.has(next))
        throw new DatasetError(
          "Dataset pagination did not advance while hasMore was true; refusing a partial import",
        );
      cursors.add(next);
      cursor = next;
    }
    return applyStaticDatasetFilters(data, options);
  }
  if (typeof dataset !== "string")
    throw new TypeError("Dataset must be a local path, hf: source or orq: ID");
  let text: string;
  try {
    text = await readFile(dataset, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `Dataset file not found: ${dataset}. For HuggingFace datasets, use "hf:org/repo" format.`,
        { cause: error },
      );
    throw new DatasetError(
      `Failed to load red team dataset from ${dataset}: ${error instanceof Error ? error.message : String(error)}. Check that it contains valid JSON in {"samples": [...]} format.`,
      { cause: error },
    );
  }
  try {
    return datasetToDatapoints(JSON.parse(text), options);
  } catch (error) {
    throw new DatasetError(
      `Failed to load red team dataset from ${dataset}: ${error instanceof Error ? error.message : String(error)}. Check that it contains valid JSON in {"samples": [...]} format.`,
      { cause: error },
    );
  }
}
export function createOwaspEvaluator(
  options: OWASPEvaluatorOptions & {
    judgeRepetitions?: number;
    logPanelWarnings?: boolean;
  } = {},
): Evaluator & { evaluatorType: "llm_eval" } {
  const model = evaluatorModelFor(options.evaluatorModel, options.cfg),
    base = options.cfg ?? PIPELINE_CONFIG.evaluator;
  const call = base instanceof EvaluatorConfig ? base.asCallConfig() : base;
  const cfg = new LLMCallConfig({
    ...call.setValues(
      ...(Object.keys(
        LLMCallConfigSchema.shape,
      ) as (keyof LLMCallConfigInput)[]),
    ),
    extraKwargs: { ...base.extraKwargs, ...options.llmKwargs },
  });
  let client: Promise<OpenAI> | undefined;
  const supplied = options.llmClient ?? (base.client as OpenAI | undefined);
  const getClient = () => {
    client ??= supplied
      ? Promise.resolve(supplied)
      : createAsyncLlmClient(undefined, { maxRetries: 0 });
    return client;
  };
  const panel = [
      ...new Set([model, ...(options.judges ?? []).filter(Boolean)]),
    ],
    replacements = (options.replacementJudges ?? []).filter(
      (judge) => judge && !panel.includes(judge),
    );
  const repetitions = Math.max(
      1,
      options.judgeRepetitions ?? options.repetitions ?? 1,
    ),
    minSuccess = Math.max(1, options.minSuccessfulJudges ?? 1);
  if (minSuccess > panel.length)
    throw new RangeError(
      `minSuccessfulJudges (${minSuccess}) exceeds the effective panel size (${panel.length}) after de-duplication; panel=${JSON.stringify(panel)}`,
    );
  for (const issue of panelCompositionMessages(
    [model, ...(options.judges ?? [])],
    options.targetModels ?? [],
    { strict: options.strictPanel, tieOutcome: RED_TEAM_TIE_OUTCOME },
  )) {
    if (options.strictPanel) throw new RangeError(issue);
    if (options.logPanelWarnings ?? true) console.warn(issue);
  }
  return {
    name: "owasp-agentic-security",
    evaluatorType: "llm_eval",
    scorer: async ({ data, output }) => {
      const category = String(data.inputs.category ?? "");
      return annotateCurrentSpan(
        { "orq.redteam.category": category, "orq.redteam.model": model },
        async (span) => {
          const errorResult = (
            explanation: string,
            tokenUsage: Usage | null = null,
            errorPayload?: Record<string, unknown>,
          ): EvaluationResult<string> => {
            setSpanAttrs(span, {
              "orq.redteam.passed": "inconclusive",
              output: explanation,
            });
            return {
              value: "error",
              explanation,
              pass: null,
              tokenUsage,
              rawOutput: errorPayload
                ? { [EVAL_ERROR_RAW_OUTPUT_KEY]: errorPayload }
                : null,
            };
          };
          if (!category)
            return errorResult(
              "Missing 'category' in datapoint inputs - cannot score",
            );
          const entity = getEvaluatorForCategory(category, model);
          if (!entity)
            return errorResult(`No evaluator found for category ${category}`);
          const targetError = outputErrorText(output);
          if (targetError !== null)
            return errorResult(
              `Target agent error - not scored: ${targetError}`,
            );
          const evalReplacements = buildEvalReplacements({
            inputMessages:
              (data.inputs.messages as Record<string, unknown>[]) ?? [],
            outputMessages: outputToMessages(output),
          });
          const resolvedClient = await getClient();
          const judge = (model: string) =>
            runJudge({
              client: resolvedClient,
              model,
              cfg,
              promptTemplate: entity.prompt,
              replacements: evalReplacements,
            });
          if (panel.length === 1 && repetitions === 1 && !replacements.length) {
            const outcome = await judge(model);
            if (outcome.errorKind === "timeout")
              return errorResult(
                `Evaluation timed out after ${outcome.timeoutMs}ms`,
                outcome.tokenUsage,
                judgeErrorPayload(outcome, category),
              );
            if (outcome.errorKind !== null || outcome.payload === null)
              return errorResult(
                `Evaluation error: ${outcome.errorMessage}`,
                outcome.tokenUsage,
                judgeErrorPayload(outcome, category),
              );
            const passed =
              typeof outcome.payload.value === "boolean"
                ? outcome.payload.value
                : null;
            setSpanAttrs(span, {
              "orq.redteam.passed": passed ?? "inconclusive",
              output: outcome.payload.explanation,
            });
            return {
              value: outcome.payload.value ?? "inconclusive",
              explanation: outcome.payload.explanation,
              pass: passed,
              tokenUsage: outcome.tokenUsage,
              rawOutput: { raw_content: outcome.rawContent },
            };
          }
          let lastError: JudgeOutcome | null = null;
          const deliberation = await runJury({
            judgeFn: async (model) => {
              const outcome = await judge(model);
              if (outcome.errorKind !== null || outcome.payload === null) {
                lastError = outcome;
                return {
                  error: outcome.errorMessage || outcome.errorKind || "error",
                  tokenUsage: outcome.tokenUsage,
                };
              }
              return {
                value: outcome.payload.value,
                explanation: outcome.payload.explanation,
                tokenUsage: outcome.tokenUsage,
                abstained: outcome.payload.abstain,
              };
            },
            panel,
            repetitions,
            replacementJudges: replacements,
            minSuccessfulJudges: minSuccess,
            verdictKind: "categorical",
            tieBreak: () => false,
          });
          const passed =
              typeof deliberation.verdict === "boolean"
                ? deliberation.verdict
                : null,
            explanation = appendJurySummary(
              deliberation.explanation,
              deliberation.jury,
            );
          setSpanAttrs(span, {
            "orq.redteam.passed": passed ?? "inconclusive",
            output: explanation,
          });
          setJurySpanAttrs(span, deliberation.jury);
          const rawOutput = attachJuryRawOutput(
            { value: passed, explanation: deliberation.explanation },
            deliberation.jury,
            passed === null && lastError !== null
              ? judgeErrorPayload(lastError, category)
              : null,
          );
          return {
            value: passed ?? "inconclusive",
            explanation,
            pass: passed,
            tokenUsage: deliberation.tokenUsage,
            rawOutput,
          };
        },
      );
    },
  };
}
