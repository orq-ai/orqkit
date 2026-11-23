import type OpenAI from "openai";
import { z } from "zod/v4";

import {
  buildEvalReplacements,
  type ClassifyQuestion,
  ClassifyQuestionSchema,
  type JudgeOutcome,
  runJudge,
} from "./common/judge.js";
import {
  type AggregatorSpec,
  appendJurySummary,
  attachJuryRawOutput,
  evenPanelTieOutcome,
  type JuryDeliberation,
  type Prediction,
  panelCompositionMessages,
  runJury,
  TIE_LOSES_VERDICT,
  type TieBreak,
  type VerdictKind,
  validateAggregator,
} from "./common/jury.js";
import type { NamedSchema } from "./common/llm-call.js";
import {
  clientRoutesThroughOrq,
  resolveLlmClient,
} from "./common/llm-client.js";
import {
  isKnownClassifyModel,
  supportsClassify,
} from "./common/model-catalogue.js";
import { roleModel } from "./common/model-roles.js";
import {
  inputsToMessages,
  outputErrorText,
  outputToMessages,
  outputToText,
} from "./common/output-adapters.js";
import {
  extractTemplatePaths,
  resolveTemplatePath,
} from "./common/template-engine.js";
import {
  DEFAULT_SMART_MODEL,
  type JuryResult,
  LLMCallConfig,
} from "./contracts.js";
import { getPreset } from "./jury-presets.js";
import {
  type PairwiseComparison,
  PairwiseComparisonSchema,
  runPairwise,
} from "./pairwise.js";
import { signalBoolean } from "./signals/models.js";
import type {
  DataPoint,
  EvaluationResult,
  Evaluator,
  Output,
  Scorer,
  ScorerParameter,
} from "./types.js";

export const DEFAULT_JUDGE_MODEL = DEFAULT_SMART_MODEL;
export const DEFAULT_JURY_MAX_TOKENS = 8000;
export const PAIRWISE_LABELS = ["A", "B", "tie"];
export const PAIRWISE_CLASSIFY_CRITERIA = {
  A: "Response A is better",
  B: "Response B is better",
  tie: "Neither is clearly better",
};
export const DEFAULT_PAIRWISE_CRITERIA =
  "Compare the two responses on accuracy and correctness, helpfulness and " +
  "completeness, clarity and organization, and relevance to the question.";

export const DEFAULT_TEMPLATE =
  "# Criteria\n{{criteria}}\n\n" +
  "# Input\n{{input.all_messages}}\n\n" +
  "# Output\n{{output.response}}\n\n" +
  "# Expected output\n{{input.expected_output}}\n";

export const DEFAULT_PAIRWISE_TEMPLATE =
  "# Criteria\n{{criteria}}\n\n" +
  "# Question\n{{question}}\n\n" +
  "# Response A\n{{response_a.output.response}}\n\n" +
  "# Response B\n{{response_b.output.response}}\n";

export type JudgeAssignment = "all" | "cyclic";
type LabelDescriptions = Record<string, string | null>;
type ScoreRange = readonly [number, number];

interface CallSettings {
  structuredOutput: boolean;
  temperature: number | null;
  maxTokens: number;
  timeoutMs: number;
  extraKwargs: Record<string, unknown> | null;
  extraBody: Record<string, unknown> | null;
  reasoningEffort: string | null;
}

// The numbers land in prompts and schemas, so they keep the Python spelling: 0.0, not 0.
function floatText(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function labelsDescription(
  descriptions: LabelDescriptions | null,
): string | null {
  if (!descriptions || !Object.values(descriptions).some(Boolean)) {
    return null;
  }
  const parts = Object.entries(descriptions).map(([label, description]) =>
    description ? `${label}: ${description}` : label,
  );
  return `One of: ${parts.join("; ")}`;
}

function levelsDescription(
  levels: readonly string[] | null,
  [lo, hi]: ScoreRange,
): string | null {
  if (!levels || levels.length === 0) {
    return null;
  }
  const step = (hi - lo) / (levels.length - 1);
  const joined = levels
    .map((level, index) => `${floatText(lo + index * step)}=${level}`)
    .join("; ");
  return `Scale from ${floatText(lo)} to ${floatText(hi)}. Levels: ${joined}`;
}

function buildVerdictModel(
  verdictKind: VerdictKind,
  labels: string[] | null,
  scoreRange: ScoreRange,
  labelDescriptions: LabelDescriptions | null = null,
  levels: readonly string[] | null = null,
): NamedSchema {
  let value: z.ZodType;
  let description: string | null;
  if (verdictKind === "categorical") {
    value =
      labels === null ? signalBoolean : z.enum(labels as [string, ...string[]]);
    description = labelsDescription(labelDescriptions);
  } else {
    value = z.number();
    description = levelsDescription(levels, scoreRange);
  }
  return {
    name: "VerdictModel",
    schema: z.object({
      explanation: z
        .string()
        .default("")
        .describe("Explanation for the verdict"),
      value: description === null ? value : value.describe(description),
    }),
  };
}

function buildReplacements(
  data: DataPoint,
  output: Output,
  criteria: string,
): Record<string, unknown> {
  const replacements = buildEvalReplacements({
    inputMessages: inputsToMessages(data.inputs),
    outputMessages: outputToMessages(output),
    expectedOutput: outputToText(data.expectedOutput),
    systemInstructions: null,
    error: outputErrorText(output),
  });
  replacements.criteria = criteria;
  return replacements;
}

function defaultSystemPrompt(
  verdictKind: VerdictKind,
  labels: string[] | null,
  scoreRange: ScoreRange,
  labelDescriptions: LabelDescriptions | null,
  levels: readonly string[] | null,
): string {
  const base =
    "You are a strict evaluator. Read the input, the model's output, any " +
    "expected output, and judge against the stated criterion. " +
    "Return a structured verdict with a 2-3 sentence explanation.";
  let prompt: string;
  let extra: string | null;
  if (verdictKind === "numeric") {
    const [lo, hi] = scoreRange;
    prompt = `${base} \`value\` must be a number between ${floatText(lo)} and ${floatText(hi)} (higher is better).`;
    extra = levelsDescription(levels, scoreRange);
  } else if (labels && labels.length > 0) {
    prompt = `${base} \`value\` must be exactly one of: ${labels.join(", ")}.`;
    extra = labelsDescription(labelDescriptions);
  } else {
    return `${base} \`value\` must be a boolean: true if the criterion is met, false otherwise.`;
  }
  return extra === null ? prompt : `${prompt} ${extra}`;
}

function buildClassifyState(
  paths: readonly string[],
  replacements: Record<string, unknown>,
): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const path of paths) {
    if (path === "criteria") {
      continue;
    }
    const { found, value } = resolveTemplatePath(replacements, path, {
      preferNested: true,
    });
    if (!found) {
      console.error(
        `classify state: no value for template path '${path}', skipping it`,
      );
      continue;
    }
    state[path] = value;
  }
  return state;
}

function warnClassifyRepetitions(repetitions: number, pairwise: boolean): void {
  if (repetitions <= 1) {
    return;
  }
  console.warn(
    pairwise
      ? `repetitions=${repetitions} on a pairwise panel seating a classify judge: each A/B ordering is deterministic, so repetitions bill extra calls for identical answers; \`swap\` still runs the two distinct orderings as intended`
      : `repetitions=${repetitions} on a panel seating a classify judge: a classify verdict is deterministic, so the extra calls are billed for identical answers`,
  );
}

interface ClassifyQuestionFields {
  verdictKind: VerdictKind;
  criteria: string | null;
  labelDescriptions: LabelDescriptions | null;
  levels: readonly string[] | null;
  threshold: number;
  state: Record<string, unknown>;
}

function buildClassifyQuestion(
  fields: ClassifyQuestionFields,
): ClassifyQuestion | null {
  const { verdictKind, criteria, labelDescriptions, levels, threshold, state } =
    fields;
  if (!criteria) {
    return null;
  }
  if (verdictKind === "numeric") {
    if (!levels || levels.length === 0) {
      return null;
    }
    return ClassifyQuestionSchema.parse({
      kind: "score",
      instructions: criteria,
      criteria: [...levels],
      state,
    });
  }
  if (labelDescriptions && Object.keys(labelDescriptions).length > 0) {
    return ClassifyQuestionSchema.parse({
      kind: "choice",
      instructions: criteria,
      criteria: { ...labelDescriptions },
      state,
    });
  }
  if (!(threshold >= 0 && threshold <= 1)) {
    return null;
  }
  return ClassifyQuestionSchema.parse({
    kind: "noul",
    instructions: criteria,
    state,
    noulThreshold: threshold,
  });
}

interface ClassifyConfiguration {
  criteria: string | null;
  verdictKind: VerdictKind;
  levels: readonly string[] | null;
  scoreRange: ScoreRange;
  labelNames: string[] | null;
  threshold: number;
}

function validateClassifyConfiguration(config: ClassifyConfiguration): void {
  const { criteria, verdictKind, levels, scoreRange, labelNames, threshold } =
    config;
  if (!criteria) {
    throw new Error(
      "A classify judge needs `criteria` to ask about; `prompt` alone does not build a classify question.",
    );
  }
  if (verdictKind === "numeric" && (!levels || levels.length === 0)) {
    throw new Error(
      "A classify judge scoring numerically needs `levels`: 2-10 ordered level descriptions the score is a weighted mean over.",
    );
  }
  if (
    verdictKind === "numeric" &&
    (scoreRange[0] !== 0 || scoreRange[1] !== 1)
  ) {
    throw new Error(
      `A classify judge returns a score scaled into (0.0, 1.0), so scoreRange (${scoreRange.join(", ")}) cannot be honoured. Drop the override or drop the classify judge.`,
    );
  }
  if (
    verdictKind === "categorical" &&
    (!labelNames || labelNames.length === 0) &&
    !(threshold >= 0 && threshold <= 1)
  ) {
    throw new Error(
      `A classify judge compares \`threshold\` against a probability, so threshold (${threshold}) must lie in [0.0, 1.0].`,
    );
  }
}

interface IgnoredSettings extends CallSettings {
  allJudges: readonly string[];
  classifyJudges: readonly string[];
  systemPrompt: string | null;
  prompt: string | null;
}

function warnClassifyIgnoredSettings(settings: IgnoredSettings): void {
  const { allJudges, classifyJudges } = settings;
  const candidates: [string, boolean][] = [
    ["systemPrompt", settings.systemPrompt !== null],
    ["prompt", settings.prompt !== null],
    ["temperature", settings.temperature !== null],
    ["structuredOutput", settings.structuredOutput === false],
    ["maxTokens", settings.maxTokens !== DEFAULT_JURY_MAX_TOKENS],
    ["reasoningEffort", settings.reasoningEffort !== null],
    ["extraKwargs", Object.keys(settings.extraKwargs ?? {}).length > 0],
    ["extraBody", Object.keys(settings.extraBody ?? {}).length > 0],
  ];
  const ignored = candidates.filter(([, set]) => set).map(([name]) => name);
  if (ignored.length === 0) {
    return;
  }
  const prompted = allJudges.some(
    (judge) => !classifyJudges.includes(judge) && !isKnownClassifyModel(judge),
  );
  const stillApply = prompted
    ? " (they still apply to any prompted judges)"
    : "";
  console.warn(
    `Panel seats a classify judge (${classifyJudges.join(", ")}); it is not prompted, so these settings do not reach it: ${ignored.join(", ")}${stillApply}.`,
  );
}

function warnUnreadCriteria(
  prompt: string | null,
  criteria: string | null,
  classifySeated: boolean,
): void {
  if (classifySeated || !prompt || !criteria) {
    return;
  }
  if (extractTemplatePaths(prompt).includes("criteria")) {
    return;
  }
  console.warn(
    "criteria is set but no judge reads it synchronously: no classify judge is known yet and the prompt never renders {{criteria}}. A classify seat discovered from the catalogue still reads it as its question; otherwise add the placeholder or drop `criteria`.",
  );
}

function outcomeToPrediction(outcome: JudgeOutcome): Prediction {
  const tokenUsage = outcome.tokenUsage;
  if (outcome.errorKind !== null) {
    return { error: outcome.errorMessage || outcome.errorKind, tokenUsage };
  }
  const payload = outcome.payload;
  if (payload === null) {
    return { error: "judge returned no payload", tokenUsage };
  }
  if (payload.abstain || payload.value === null) {
    return { abstained: true, explanation: payload.explanation, tokenUsage };
  }
  return {
    value: payload.value,
    explanation: payload.explanation,
    tokenUsage,
    rawOutput: outcome.rawOutput,
  };
}

interface SingleJudgeCall extends CallSettings {
  client: OpenAI;
  model: string;
  template: string;
  replacements: Record<string, unknown>;
  systemPrompt: string;
  verdictModel: NamedSchema;
  classify: ClassifyQuestion | null;
  classifyStatePaths: readonly string[];
  classifyEmptyWarned: { value: boolean };
  onClassify: (model: string) => void;
}

async function runSingleJudge(call: SingleJudgeCall): Promise<Prediction> {
  const { client, model, classify, classifyStatePaths } = call;
  const runtimeClassify =
    clientRoutesThroughOrq(client) && (await supportsClassify(model, client));
  let cfg: LLMCallConfig;
  if (runtimeClassify) {
    call.onClassify(model);
    if (
      classify !== null &&
      Object.keys(classify.state).length === 0 &&
      !call.classifyEmptyWarned.value
    ) {
      call.classifyEmptyWarned.value = true;
      const paths = JSON.stringify(
        classifyStatePaths.filter((path) => path !== "criteria"),
      );
      console.warn(
        `classify state is empty: none of ${paths} resolved against the available values, so the classify judge sees the criteria and no material to judge. Name the paths that do resolve with stateFields, or add the placeholders to the prompt template.`,
      );
    }
    // Sampling settings would count as explicitly set on a config nothing reads them from.
    cfg = new LLMCallConfig({ model, timeoutMs: call.timeoutMs });
  } else {
    // The Responses endpoint is the priced one on the router (RES-1295); runJudge falls
    // back to chat completions for a model it refuses.
    cfg = new LLMCallConfig({
      model,
      api: "responses",
      maxTokens: call.maxTokens,
      timeoutMs: call.timeoutMs,
      extraKwargs: call.extraKwargs ?? {},
      extraBody: call.extraBody ?? {},
      reasoningEffort: call.reasoningEffort,
    });
  }
  const outcome = await runJudge({
    client,
    model,
    cfg,
    promptTemplate: call.template,
    replacements: call.replacements,
    systemPrompt: call.systemPrompt,
    responseModel: call.verdictModel,
    structuredOutput: call.structuredOutput,
    temperature: call.temperature,
    spanAttributes: { "orq.llm.purpose": "judge" },
    classify: runtimeClassify ? classify : null,
  });
  return outcomeToPrediction(outcome);
}

function juryErrorPayload(jury: JuryResult): Record<string, unknown> | null {
  const errors = jury.votes.flatMap((vote) => (vote.error ? [vote.error] : []));
  if (errors.length === 0) {
    return null;
  }
  return {
    message: `Jury reached no verdict; last judge error: ${errors.at(-1)}`,
    errorType: "jury_no_verdict",
    stage: "evaluation",
    code: "jury_no_verdict",
    details: {
      judgesConfigured: jury.judgesConfigured,
      judgesFailed: jury.judgesFailed,
      judgeErrors: errors,
    },
  };
}

type JuryEvaluation = EvaluationResult<string | number | boolean>;

function toEvaluationResult(
  deliberation: JuryDeliberation,
  verdictKind: VerdictKind,
  passingLabels: readonly string[] | null,
  threshold: number,
  [lo, hi]: ScoreRange,
): JuryEvaluation {
  const { verdict, jury, tokenUsage } = deliberation;
  let value: string | number | boolean;
  let pass: boolean | null;
  if (verdict === null) {
    value = "inconclusive";
    pass = null;
  } else if (verdictKind === "numeric") {
    const rawScore = Number(verdict);
    if (Number.isNaN(rawScore)) {
      throw new Error(`could not read verdict as a number: ${verdict}`);
    }
    if (!(lo <= rawScore && rawScore <= hi)) {
      console.warn(
        `judge returned ${rawScore} outside scoreRange (${lo}, ${hi}); clamping`,
      );
    }
    value = Math.min(Math.max(rawScore, lo), hi);
    pass = value >= threshold;
  } else if (typeof verdict === "boolean") {
    value = verdict;
    pass = verdict;
  } else {
    value = verdict;
    pass =
      passingLabels && passingLabels.length > 0
        ? passingLabels.includes(String(verdict))
        : null;
  }
  return {
    value,
    explanation: appendJurySummary(deliberation.explanation, jury),
    pass,
    tokenUsage,
    rawOutput: attachJuryRawOutput(
      null,
      jury,
      verdict === null ? juryErrorPayload(jury) : null,
    ),
  };
}

function resolvePanelOption(
  judges: readonly string[] | null,
  model: string | null,
): string[] {
  if (judges !== null && model !== null) {
    throw new Error("Pass either `judges` or `model`, not both.");
  }
  if (judges !== null) {
    if (judges.length === 0) {
      throw new Error("`judges` must be a non-empty list of judge models.");
    }
    return [...judges];
  }
  if (model !== null) {
    if (!model.trim()) {
      throw new Error("`model` must be a non-empty judge model identifier.");
    }
    return [model];
  }
  return [roleModel("smart")];
}

function resolveAndValidatePanel(
  judges: readonly string[] | null,
  model: string | null,
  minSuccessfulJudges: number,
  tieOutcome: string | null = TIE_LOSES_VERDICT,
): { panel: string[]; deduped: string[] } {
  const panel = resolvePanelOption(judges, model);
  const deduped = [...new Set(panel)];
  if (!(minSuccessfulJudges >= 1 && minSuccessfulJudges <= deduped.length)) {
    throw new Error(
      `minSuccessfulJudges (${minSuccessfulJudges}) must be between 1 and the deduplicated panel size (${deduped.length}).`,
    );
  }
  for (const issue of panelCompositionMessages(panel, [], { tieOutcome })) {
    console.warn(issue);
  }
  return { panel, deduped };
}

interface PresetChoice {
  preset: string | null;
  judges: readonly string[] | null;
  model: string | null;
  aggregator: AggregatorSpec | null;
  minSuccessfulJudges: number | null;
  verdictKind: VerdictKind;
  assignment: JudgeAssignment;
}

function applyPreset(choice: PresetChoice): {
  judges: readonly string[] | null;
  aggregator: AggregatorSpec | null;
  minSuccessfulJudges: number;
} {
  const { preset, judges, model, aggregator, minSuccessfulJudges } = choice;
  if (preset === null) {
    return {
      judges,
      aggregator,
      minSuccessfulJudges: minSuccessfulJudges ?? 1,
    };
  }
  if (judges !== null || model !== null) {
    throw new Error("Pass either `preset` or `judges`/`model`, not both.");
  }
  if (choice.assignment !== "all") {
    throw new Error(
      `preset='${preset}' seats a panel that votes on every item, so it cannot run with assignment='${choice.assignment}'. Pass \`judges\` explicitly to run a rotation.`,
    );
  }
  const spec = getPreset(preset);
  const panel = [...spec.judges];
  return {
    judges: panel,
    aggregator:
      aggregator ??
      (choice.verdictKind === "numeric" ? spec.numericAggregation : "majority"),
    minSuccessfulJudges:
      minSuccessfulJudges ?? Math.floor(panel.length / 2) + 1,
  };
}

function validateAssignment(
  assignment: string,
  minSuccessfulJudges: number,
): void {
  if (assignment !== "all" && assignment !== "cyclic") {
    throw new Error(
      `unknown assignment: '${assignment}'. Use 'all' or 'cyclic'.`,
    );
  }
  if (assignment === "cyclic" && minSuccessfulJudges > 1) {
    throw new Error(
      `assignment="cyclic" runs exactly one judge per item, so minSuccessfulJudges (${minSuccessfulJudges}) must be 1.`,
    );
  }
}

// Declaring an evaluator must not require credentials, so the client resolves on first use.
function lazyClient(client: OpenAI | null): () => Promise<OpenAI> {
  let pending: Promise<OpenAI> | null = client ? Promise.resolve(client) : null;
  return () => {
    pending ??= resolveLlmClient(null, { maxRetries: 0 }).then(
      (resolved) => resolved.client,
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
}

export interface LlmJuryOptions extends Partial<CallSettings> {
  name: string;
  /** The rubric. A classify judge takes it as its question; a prompted judge reads it through `{{criteria}}`. */
  criteria?: string | null;
  /** Overrides the default template. At least one of `criteria` and `prompt` is required. */
  prompt?: string | null;
  systemPrompt?: string | null;
  /** Seats a named panel from `PRESETS`; cannot be combined with `judges` or `model`. */
  preset?: string | null;
  judges?: readonly string[] | null;
  /** Shorthand for a single-judge panel. */
  model?: string | null;
  repetitions?: number;
  /** `all` runs every judge on every item; `cyclic` runs one judge per item, rotating by dataset row. */
  assignment?: JudgeAssignment;
  replacementJudges?: readonly string[] | null;
  minSuccessfulJudges?: number | null;
  verdictKind?: VerdictKind;
  /** Plain list or `{label: description}`. Omit for a boolean verdict. */
  labels?: readonly string[] | LabelDescriptions | null;
  /** 2 to 10 ordered level descriptions; numeric verdicts only. */
  levels?: readonly string[] | null;
  /** Without it a labeled verdict records no pass or fail. */
  passingLabels?: readonly string[] | null;
  /** Template paths handed to a classify judge. Defaults to every placeholder the template renders. */
  stateFields?: readonly string[] | null;
  aggregator?: AggregatorSpec | null;
  threshold?: number;
  scoreRange?: ScoreRange;
  tieBreak?: TieBreak;
  client?: OpenAI | null;
}

/** Builds a jury (or single-judge) LLM evaluator for `evaluators: [...]`. */
export function llmJury(options: LlmJuryOptions): Evaluator {
  const {
    name,
    criteria = null,
    prompt = null,
    systemPrompt = null,
    preset = null,
    model = null,
    repetitions = 1,
    assignment = "all",
    replacementJudges = null,
    verdictKind = "categorical",
    labels = null,
    levels = null,
    passingLabels = null,
    stateFields = null,
    threshold = 0.5,
    scoreRange = [0, 1] as const,
    tieBreak,
  } = options;
  const settings: CallSettings = {
    structuredOutput: options.structuredOutput ?? true,
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? DEFAULT_JURY_MAX_TOKENS,
    timeoutMs: options.timeoutMs ?? 90_000,
    extraKwargs: options.extraKwargs ?? null,
    extraBody: options.extraBody ?? null,
    reasoningEffort: options.reasoningEffort ?? null,
  };

  let labelDescriptions: LabelDescriptions | null = null;
  if (labels !== null) {
    labelDescriptions = Array.isArray(labels)
      ? Object.fromEntries((labels as string[]).map((label) => [label, null]))
      : { ...(labels as LabelDescriptions) };
  }
  const labelNames =
    labelDescriptions === null ? null : Object.keys(labelDescriptions);
  const hasPassingLabels = passingLabels !== null && passingLabels.length > 0;
  if (!criteria && !prompt) {
    throw new Error("Pass `criteria`, `prompt`, or both.");
  }
  if (repetitions < 1) {
    throw new Error(`repetitions (${repetitions}) must be >= 1.`);
  }
  if (
    verdictKind !== "categorical" &&
    (labelNames?.length || hasPassingLabels)
  ) {
    throw new Error(
      "`labels`/`passingLabels` are only valid for verdictKind='categorical'.",
    );
  }
  if (levels !== null && verdictKind !== "numeric") {
    throw new Error("`levels` is only valid for verdictKind='numeric'.");
  }
  if (levels !== null && !(levels.length >= 2 && levels.length <= 10)) {
    throw new Error(
      `\`levels\` must list between 2 and 10 ordered descriptions, got ${levels.length}.`,
    );
  }
  if (labelNames !== null && labelNames.length < 2) {
    throw new Error("categorical `labels` must list at least two options.");
  }
  if (hasPassingLabels && !labelNames?.length) {
    throw new Error(
      "`passingLabels` requires `labels` (categorical labeled mode); boolean mode derives pass/fail from the verdict directly.",
    );
  }
  if (
    labelNames?.length &&
    hasPassingLabels &&
    !passingLabels.every((label) => labelNames.includes(label))
  ) {
    throw new Error("`passingLabels` must be a subset of `labels`.");
  }
  if (verdictKind === "numeric" && scoreRange[0] >= scoreRange[1]) {
    throw new Error(
      `scoreRange (${scoreRange.join(", ")}) must be increasing (lo < hi).`,
    );
  }
  if (
    verdictKind === "numeric" &&
    !(scoreRange[0] <= threshold && threshold <= scoreRange[1])
  ) {
    throw new Error(
      `threshold (${threshold}) must lie within scoreRange (${scoreRange.join(", ")}).`,
    );
  }

  const seating = applyPreset({
    preset,
    judges: options.judges ?? null,
    model,
    aggregator: options.aggregator ?? null,
    minSuccessfulJudges: options.minSuccessfulJudges ?? null,
    verdictKind,
    assignment,
  });
  const { aggregator, minSuccessfulJudges } = seating;
  validateAggregator(aggregator, verdictKind);
  const { panel, deduped } = resolveAndValidatePanel(
    seating.judges,
    model,
    minSuccessfulJudges,
    evenPanelTieOutcome(aggregator, verdictKind, tieBreak),
  );
  validateAssignment(assignment, minSuccessfulJudges);

  const classifyConfig: ClassifyConfiguration = {
    criteria,
    verdictKind,
    levels,
    scoreRange,
    labelNames,
    threshold,
  };
  const allJudges = [...panel, ...(replacementJudges ?? [])];
  const classifyJudges = allJudges.filter(isKnownClassifyModel);
  const warnIgnored = (seated: readonly string[]) =>
    warnClassifyIgnoredSettings({
      ...settings,
      allJudges,
      classifyJudges: seated,
      systemPrompt,
      prompt,
    });
  if (classifyJudges.length > 0) {
    validateClassifyConfiguration(classifyConfig);
    warnClassifyRepetitions(repetitions, false);
    warnIgnored(classifyJudges);
  }
  warnUnreadCriteria(prompt, criteria, classifyJudges.length > 0);
  if (settings.temperature === 0) {
    console.warn(
      "temperature=0: reasoning models (o-series, gpt-5, ...) often score worse at temp 0. Leave it unset unless you know your model benefits.",
    );
  }

  const verdictModel = buildVerdictModel(
    verdictKind,
    labelNames,
    scoreRange,
    labelDescriptions,
    levels,
  );
  const template = prompt ?? DEFAULT_TEMPLATE;
  // Resolved once: extractTemplatePaths warns about rejected placeholders, per call otherwise.
  const classifyStatePaths = criteria
    ? (stateFields ?? extractTemplatePaths(template))
    : [];
  const classifyEmptyWarned = { value: false };
  const runtimeClassifyWarned = new Set(classifyJudges);
  const onClassify = (seat: string) => {
    if (runtimeClassifyWarned.has(seat)) {
      return;
    }
    validateClassifyConfiguration(classifyConfig);
    runtimeClassifyWarned.add(seat);
    warnClassifyRepetitions(repetitions, false);
    warnIgnored([seat]);
  };
  const resolvedSystemPrompt =
    systemPrompt ??
    defaultSystemPrompt(
      verdictKind,
      labelNames,
      scoreRange,
      labelDescriptions,
      levels,
    );
  const getClient = lazyClient(options.client ?? null);
  let cursor = 0;

  const scorer: Scorer = async (params: ScorerParameter) => {
    const { data, output } = params;
    const targetError = outputErrorText(output);
    if (targetError !== null) {
      console.warn(`Target errored, skipping judges: ${targetError}`);
      return {
        value: "inconclusive",
        explanation: `Not judged: the target returned an error: ${targetError}`,
        pass: null,
      };
    }
    // Taken before the first await so concurrent direct calls still get balanced shares.
    let runPanel: readonly string[] = panel;
    if (assignment === "cyclic") {
      const slot = params.row ?? cursor++;
      runPanel = [deduped[slot % deduped.length] as string];
    }
    const client = await getClient();
    const replacements = buildReplacements(data, output, criteria ?? "");
    const classify = buildClassifyQuestion({
      verdictKind,
      criteria,
      labelDescriptions,
      levels,
      threshold,
      state: buildClassifyState(classifyStatePaths, replacements),
    });
    let deliberation = await runJury({
      judgeFn: (judgeModel) =>
        runSingleJudge({
          ...settings,
          client,
          model: judgeModel,
          template,
          replacements,
          systemPrompt: resolvedSystemPrompt,
          verdictModel,
          classify,
          classifyStatePaths,
          classifyEmptyWarned,
          onClassify,
        }),
      panel: runPanel,
      repetitions,
      replacementJudges: replacementJudges ?? [],
      minSuccessfulJudges,
      verdictKind,
      aggregator,
      tieBreak,
      // A lone judge has no redundancy: an outage must surface, not read as inconclusive.
      propagateErrors: deduped.length === 1 && !replacementJudges?.length,
    });
    if (assignment === "cyclic") {
      // One vote would report perfect agreement, indistinguishable from a unanimous panel.
      deliberation = {
        ...deliberation,
        jury: { ...deliberation.jury, stats: null, rawAgreement: null },
      };
    }
    return toEvaluationResult(
      deliberation,
      verdictKind,
      passingLabels,
      threshold,
      scoreRange,
    );
  };
  return { name, scorer };
}

function pairwiseSystemPrompt(): string {
  return (
    "You are an impartial judge comparing two AI responses, A and B, to a " +
    "question. Judge which is better against the stated criteria. Return a " +
    "structured verdict: `value` must be exactly one of 'A', 'B', or 'tie', " +
    "with a 2-3 sentence explanation."
  );
}

function sideToNamespace(
  prefix: string,
  side: Output,
): Record<string, unknown> {
  return buildEvalReplacements({
    prefix,
    inputMessages: [],
    outputMessages: outputToMessages(side),
    expectedOutput: "",
    systemInstructions: null,
    error: outputErrorText(side),
  });
}

export interface PairwiseComparatorOptions extends Partial<CallSettings> {
  panel: string[];
  criteria: string;
  template?: string | null;
  systemPrompt?: string | null;
  swap: boolean;
  repetitions: number;
  assignment?: JudgeAssignment;
  replacementJudges?: readonly string[] | null;
  minSuccessfulJudges: number;
  client?: OpenAI | null;
  stateFields?: readonly string[] | null;
  /** Set by `llmJuryPairwise`; left out when the comparator is built by hand. */
  classifySeated?: boolean;
}

/** A configured pairwise LLM jury. Call `compare` on an A/B pair. */
export class PairwiseComparator {
  private readonly panel: string[];
  private readonly criteria: string;
  private readonly systemPrompt: string;
  private readonly systemPromptWasSet: boolean;
  private readonly template: string;
  private readonly templateWasSet: boolean;
  private readonly swap: boolean;
  private readonly repetitions: number;
  private readonly assignment: JudgeAssignment;
  private readonly replacementJudges: readonly string[] | null;
  private readonly minSuccessfulJudges: number;
  private readonly settings: CallSettings;
  private readonly getClient: () => Promise<OpenAI>;
  private readonly verdictModel: NamedSchema;
  private readonly classifyStatePaths: readonly string[];
  private readonly classifyEmptyWarned = { value: false };
  private readonly classifyWarned: Set<string>;
  private cursor = 0;

  constructor(options: PairwiseComparatorOptions) {
    this.panel = options.panel;
    this.criteria = options.criteria;
    this.systemPromptWasSet = (options.systemPrompt ?? null) !== null;
    this.systemPrompt = options.systemPrompt ?? pairwiseSystemPrompt();
    this.templateWasSet = (options.template ?? null) !== null;
    this.template = options.template ?? DEFAULT_PAIRWISE_TEMPLATE;
    this.swap = options.swap;
    this.repetitions = options.repetitions;
    this.assignment = options.assignment ?? "all";
    this.replacementJudges = options.replacementJudges ?? null;
    this.minSuccessfulJudges = options.minSuccessfulJudges;
    this.settings = {
      structuredOutput: options.structuredOutput ?? true,
      temperature: options.temperature ?? null,
      maxTokens: options.maxTokens ?? DEFAULT_JURY_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? 90_000,
      extraKwargs: options.extraKwargs ?? null,
      extraBody: options.extraBody ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
    };
    this.getClient = lazyClient(options.client ?? null);
    this.verdictModel = buildVerdictModel(
      "categorical",
      PAIRWISE_LABELS,
      [0, 1],
    );
    this.classifyStatePaths =
      options.stateFields ?? extractTemplatePaths(this.template);
    const directConstruction = options.classifySeated === undefined;
    const seats = this.allJudges().filter(isKnownClassifyModel);
    this.classifyWarned = new Set(directConstruction ? [] : seats);
    if (directConstruction) {
      for (const judge of seats) {
        this.warnRuntimeClassify(judge);
      }
    }
  }

  private allJudges(): string[] {
    return [...this.panel, ...(this.replacementJudges ?? [])];
  }

  private warnRuntimeClassify(model: string): void {
    if (this.classifyWarned.has(model)) {
      return;
    }
    this.classifyWarned.add(model);
    warnClassifyRepetitions(this.repetitions, true);
    warnClassifyIgnoredSettings({
      ...this.settings,
      allJudges: this.allJudges(),
      classifyJudges: [model],
      systemPrompt: this.systemPromptWasSet ? this.systemPrompt : null,
      prompt: this.templateWasSet ? this.template : null,
    });
  }

  /** A side that carries a target-level error is never judged: the result would be noise. */
  async compare(comparison: {
    question: string;
    responseA: Output;
    responseB: Output;
  }): Promise<PairwiseComparison> {
    const { question, responseA, responseB } = comparison;
    for (const [label, side] of [
      ["A", responseA],
      ["B", responseB],
    ] as const) {
      const error = outputErrorText(side);
      if (error !== null) {
        console.warn(
          `Pairwise side ${label} errored, skipping judges: ${error}`,
        );
        return PairwiseComparisonSchema.parse({ winner: "inconclusive" });
      }
    }
    // Taken before the first await so concurrent compares still get balanced shares.
    const runPanel =
      this.assignment === "cyclic"
        ? [this.panel[this.cursor++ % this.panel.length] as string]
        : this.panel;
    const client = await this.getClient();
    return runPairwise<Output>({
      judgeFn: (first, second, model) => {
        const replacements: Record<string, unknown> = {
          question,
          criteria: this.criteria,
          ...sideToNamespace("response_a", first),
          ...sideToNamespace("response_b", second),
        };
        const classify = ClassifyQuestionSchema.parse({
          kind: "choice",
          instructions: this.criteria,
          criteria: { ...PAIRWISE_CLASSIFY_CRITERIA },
          state: buildClassifyState(this.classifyStatePaths, replacements),
        });
        return runSingleJudge({
          ...this.settings,
          client,
          model,
          template: this.template,
          replacements,
          systemPrompt: this.systemPrompt,
          verdictModel: this.verdictModel,
          classify,
          classifyStatePaths: this.classifyStatePaths,
          classifyEmptyWarned: this.classifyEmptyWarned,
          onClassify: (seat) => this.warnRuntimeClassify(seat),
        });
      },
      panel: runPanel,
      responseA,
      responseB,
      swap: this.swap,
      repetitions: this.repetitions,
      replacementJudges: this.replacementJudges,
      minSuccessfulJudges: this.minSuccessfulJudges,
      propagateErrors:
        this.panel.length === 1 && !this.replacementJudges?.length,
    });
  }
}

export interface LlmJuryPairwiseOptions extends Partial<CallSettings> {
  judges?: readonly string[] | null;
  model?: string | null;
  criteria?: string | null;
  prompt?: string | null;
  systemPrompt?: string | null;
  /** Runs each judge in both orderings to correct for position bias. */
  swap?: boolean;
  repetitions?: number;
  assignment?: JudgeAssignment;
  replacementJudges?: readonly string[] | null;
  minSuccessfulJudges?: number;
  client?: OpenAI | null;
  stateFields?: readonly string[] | null;
}

/** Builds a pairwise (A vs B) LLM jury. Roll many comparisons up with `buildReport`. */
export function llmJuryPairwise(
  options: LlmJuryPairwiseOptions = {},
): PairwiseComparator {
  const {
    criteria = null,
    prompt = null,
    systemPrompt = null,
    swap = true,
    repetitions = 1,
    assignment = "all",
    replacementJudges = null,
    minSuccessfulJudges = 1,
  } = options;
  const settings: CallSettings = {
    structuredOutput: options.structuredOutput ?? true,
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? DEFAULT_JURY_MAX_TOKENS,
    timeoutMs: options.timeoutMs ?? 90_000,
    extraKwargs: options.extraKwargs ?? null,
    extraBody: options.extraBody ?? null,
    reasoningEffort: options.reasoningEffort ?? null,
  };
  if (repetitions < 1) {
    throw new Error(`repetitions (${repetitions}) must be >= 1.`);
  }
  const { deduped } = resolveAndValidatePanel(
    options.judges ?? null,
    options.model ?? null,
    minSuccessfulJudges,
  );
  validateAssignment(assignment, minSuccessfulJudges);
  const allJudges = [...deduped, ...(replacementJudges ?? [])];
  const classifyJudges = allJudges.filter(isKnownClassifyModel);
  if (classifyJudges.length > 0) {
    warnClassifyRepetitions(repetitions, true);
    warnClassifyIgnoredSettings({
      ...settings,
      allJudges,
      classifyJudges,
      systemPrompt,
      prompt,
    });
  }
  warnUnreadCriteria(prompt, criteria, classifyJudges.length > 0);
  return new PairwiseComparator({
    ...settings,
    panel: deduped,
    criteria: criteria || DEFAULT_PAIRWISE_CRITERIA,
    template: prompt,
    systemPrompt,
    swap,
    repetitions,
    assignment,
    replacementJudges,
    minSuccessfulJudges,
    client: options.client ?? null,
    stateFields: options.stateFields ?? null,
    classifySeated: classifyJudges.length > 0,
  });
}
