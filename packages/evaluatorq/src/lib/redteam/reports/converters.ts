import { pythonStrip } from "../../common/sanitize.js";
import {
  classifyErrorType,
  TargetCallResult,
} from "../../common/target-call.js";
import {
  type AgentContext,
  AgentResponse,
  EVAL_ERROR_RAW_OUTPUT_KEY,
  extractUsage,
  JURY_RAW_OUTPUT_KEY,
  parseJuryResult,
  parseUsage,
  type Usage,
} from "../../contracts.js";
import {
  AttackSource,
  AttackTechnique,
  inferFramework,
  isKnownAttackTechnique,
  normalizeCategory,
  OWASP_CATEGORY_NAMES,
  Pipeline,
} from "../contracts.js";
import { getEvaluatorMetadataForCategory } from "../frameworks/owasp/evaluators.js";
import {
  AttackStrategySchema,
  type RunError,
  RunErrorSchema,
} from "../strategy.js";
import { Turn } from "../turn.js";
import {
  getVulnerabilityDef,
  resolveCategorySafe,
} from "../vulnerability-registry.js";
import {
  codepointCompare,
  JobOutputPayload,
  JobOutputPayloadSchema,
  RedTeamReport,
  RedTeamResult,
  UnifiedEvaluationResultSchema,
} from "./models.js";
import { EvaluatedRowSchema } from "./staged.js";
import { computeReportSummary } from "./summary.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const field = (value: unknown, name: string): unknown => {
  if (!record(value)) return undefined;
  return Object.hasOwn(value, name)
    ? value[name]
    : value[name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
};
const textError = (value: unknown): string | null =>
  value == null ? null : value instanceof Error ? value.message : String(value);
function extractJury(raw: unknown) {
  if (!record(raw) || !record(raw[JURY_RAW_OUTPUT_KEY])) return null;
  try {
    return parseJuryResult(raw[JURY_RAW_OUTPUT_KEY]);
  } catch (error) {
    console.warn(
      `Discarding malformed jury payload in report conversion: ${error}`,
    );
    return null;
  }
}
function extractEvaluationError(raw: unknown): RunError | null {
  if (!record(raw) || !record(raw[EVAL_ERROR_RAW_OUTPUT_KEY])) return null;
  const parsed = RunErrorSchema.safeParse(raw[EVAL_ERROR_RAW_OUTPUT_KEY]);
  if (parsed.success) return parsed.data;
  console.warn(
    `Discarding malformed evaluation-error payload in report conversion: ${parsed.error}`,
  );
  return null;
}
function scorerError(
  error: unknown,
  vulnerable: boolean | null,
): RunError | null {
  const message = textError(error);
  return message && vulnerable === null
    ? RunErrorSchema.parse({
        message,
        errorType: "scorer_exception",
        stage: "evaluation",
        code: "scorer_exception",
      })
    : null;
}
function withoutLifted(raw: unknown): unknown {
  if (!record(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) =>
        key !== JURY_RAW_OUTPUT_KEY && key !== EVAL_ERROR_RAW_OUTPUT_KEY,
    ),
  );
}
function normalizeUsage(raw: unknown): Usage | null {
  if (!record(raw)) return null;
  return Object.hasOwn(raw, "inputTokens") || Object.hasOwn(raw, "totalTokens")
    ? parseUsage(raw)
    : extractUsage(raw);
}
const outputKeys = Object.keys(JobOutputPayloadSchema.out.shape);
function outputAliases(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const value = { ...input };
  for (const key of outputKeys) {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (key === snake) continue;
    if (!(key in value) && snake in value) value[key] = value[snake];
    delete value[snake];
  }
  return value;
}
function flattenTurns(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.turns)) return input;
  if (!input.turns.length) return { ...input, turns: 0 };
  const first = input.turns[0];
  if (!record(first) || !("attacker" in first) || !("target" in first))
    return input;
  const conversation: Record<string, unknown>[] = [],
    responseTraces: Record<string, unknown>[] = [];
  let finalResponse = "";
  for (const raw of input.turns) {
    let attacker = "",
      target = "";
    try {
      const turn =
        raw instanceof Turn ? raw : new Turn(raw as Record<string, unknown>);
      attacker = turn.attacker.text;
      target = turn.target.text;
      if (!turn.errored && (turn.target.traceId || turn.target.spanId))
        responseTraces.push({
          traceId: turn.target.traceId,
          spanId: turn.target.spanId,
        });
    } catch {}
    conversation.push(
      { role: "user", content: attacker },
      { role: "assistant", content: target },
    );
    finalResponse = target || finalResponse;
  }
  const out: Record<string, unknown> = { ...input, turns: input.turns.length };
  if (!("conversation" in out)) out.conversation = conversation;
  if (!("finalResponse" in out)) out.finalResponse = finalResponse;
  if (responseTraces.length && !("responseTraces" in out))
    out.responseTraces = responseTraces;
  return out;
}
function flattenError(input: Record<string, unknown>): Record<string, unknown> {
  const raw = input.error;
  if (raw == null || typeof raw === "string") return input;
  let data = record(raw) ? raw : {},
    message = field(data, "message") || field(data, "error"),
    errorType = field(data, "errorType");
  if (typeof message !== "string" || typeof errorType !== "string") {
    console.warn(
      "Flattening an unrecognized job output error shape as an unknown target error",
    );
    message = textError(raw) ?? "";
    errorType = "unknown";
    data = {};
  }
  const flattened = new TargetCallResult(
    new AgentResponse(),
    1,
    {
      message: message as string,
      errorType: errorType as string,
      code: typeof data.code === "string" ? data.code : null,
    },
    (field(data, "errorDetails") || data.details || null) as Record<
      string,
      unknown
    > | null,
  ).errorPayload({ turn: Number(field(data, "errorTurn") || data.turn || 1) });
  for (const name of Object.keys(flattened) as (keyof typeof flattened)[]) {
    const value = field(data, name);
    if (value !== undefined && value !== null)
      Object.assign(flattened, { [name]: value });
  }
  return { ...input, ...flattened };
}
function normalizeOutputDict(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const input = outputAliases(value),
    wrapped = input.output;
  let inner: Record<string, unknown> | null = null;
  if (record(wrapped)) inner = outputAliases(wrapped);
  else if (typeof wrapped === "string")
    inner = coerceJobOutputPayload(wrapped).toJSON();
  if (inner) {
    for (const [key, value] of Object.entries(input))
      if (key !== "output" && !(key in inner)) inner[key] = value;
    return flattenError(flattenTurns(inner));
  }
  return flattenError(flattenTurns(input));
}
export function coerceJobOutputPayload(raw: unknown): JobOutputPayload {
  if (raw instanceof AgentResponse)
    return new JobOutputPayload({
      finalResponse: raw.text,
      response: raw.text,
      tokenUsage: raw.usage,
      ...new TargetCallResult(raw, 1, raw.error, null).errorPayload(),
      conversation: raw.text ? [{ role: "assistant", content: raw.text }] : [],
    });
  if (raw == null) return new JobOutputPayload();
  if (typeof raw === "string") {
    const text = pythonStrip(raw);
    if (text.startsWith("{") && text.endsWith("}")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return new JobOutputPayload();
      }
      if (record(parsed))
        return new JobOutputPayload(normalizeOutputDict(parsed));
    }
    return new JobOutputPayload();
  }
  if (record(raw)) return new JobOutputPayload(normalizeOutputDict(raw));
  return new JobOutputPayload();
}
export function coerceJobOutputText(raw: unknown): string {
  if (raw instanceof AgentResponse) return raw.text;
  const payload = coerceJobOutputPayload(raw);
  if (payload.finalResponse !== null) return payload.finalResponse;
  if (payload.response !== null) return payload.response;
  if (payload.output !== null) return payload.output;
  if (typeof raw === "string") {
    const text = pythonStrip(raw);
    return text.startsWith("{") && text.endsWith("}") ? "" : raw;
  }
  return raw == null ? "" : String(raw);
}
function normalizeAttackTechnique(value: unknown): AttackTechnique {
  const raw = pythonStrip(String(value || ""));
  if (!raw) return AttackTechnique.INDIRECT_INJECTION;
  const lower = raw.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  if (isKnownAttackTechnique(lower)) return lower;
  console.warn(
    `Unknown attack technique ${JSON.stringify(raw)}, defaulting to direct-injection`,
  );
  return AttackTechnique.DIRECT_INJECTION;
}
function scorePassed(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = pythonStrip(value).toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}
export interface StaticReportOptions {
  agentModel?: string | null;
  agentKey?: string | null;
  description?: string | null;
  runErrors?: RunError[];
}
export function staticSampleToResult(
  sample: Record<string, unknown>,
  options: Pick<StaticReportOptions, "agentModel" | "agentKey"> = {},
): RedTeamResult {
  const normalized = { ...sample };
  if (record(sample.input))
    normalized.input = {
      ...sample.input,
      attackTechnique: normalizeAttackTechnique(
        field(sample.input, "attackTechnique"),
      ),
    };
  const rawEvaluation = field(sample, "evaluationResult");
  if (record(rawEvaluation))
    normalized.evaluationResult = {
      ...rawEvaluation,
      passed: scorePassed(rawEvaluation.passed),
      value: scorePassed(rawEvaluation.value),
    };
  const row = EvaluatedRowSchema.parse(normalized),
    input = row.input,
    category = normalizeCategory(input.category),
    vulnerability = resolveCategorySafe(category) || "";
  const meta = getEvaluatorMetadataForCategory(category),
    evalData = row.evaluationResult;
  const hasEval =
    evalData.passed !== null ||
    evalData.value !== null ||
    !!evalData.explanation ||
    !!evalData.error ||
    evalData.tokenUsage !== null ||
    evalData.rawOutput !== null;
  const evaluation = hasEval
    ? UnifiedEvaluationResultSchema.parse({
        value: evalData.value,
        passed: evalData.passed,
        explanation: evalData.explanation,
        evaluatorId: evalData.evaluatorId,
        evaluatorName: evalData.evaluatorName,
        tokenUsage: evalData.tokenUsage,
        rawOutput: withoutLifted(evalData.rawOutput),
        jury: extractJury(evalData.rawOutput),
      })
    : null;
  const vulnerable = evaluation?.passed == null ? null : !evaluation.passed;
  let evaluationError = evaluation
    ? extractEvaluationError(evalData.rawOutput) ||
      scorerError(evalData.error, vulnerable)
    : null;
  if (!evaluationError && vulnerable === null && !row.error)
    evaluationError = RunErrorSchema.parse({
      message: "The datapoint produced no evaluation result.",
      errorType: "no_evaluation",
      stage: "evaluation",
      code: "no_evaluation",
    });
  return new RedTeamResult({
    attack: {
      id: input.id,
      vulnerability,
      category,
      framework: inferFramework(category),
      attackTechnique: normalizeAttackTechnique(input.attackTechnique),
      deliveryMethods: input.deliveryMethod ? [input.deliveryMethod] : [],
      turnType: input.turnType,
      severity: input.severity,
      vulnerabilityDomain: input.vulnerabilityDomain,
      source: input.source,
      evaluatorId: input.evaluatorId || meta?.evaluatorId || category,
      evaluatorName:
        input.evaluatorName ||
        meta?.evaluatorName ||
        OWASP_CATEGORY_NAMES[category] ||
        null,
      additionalMetadata: input.additionalMetadata,
    },
    agent: { key: options.agentKey ?? null, model: options.agentModel ?? null },
    messages: row.messages,
    response: row.response,
    evaluation,
    vulnerable,
    evaluationError,
    execution: {
      turns: 1,
      maxTurns: 1,
      tokenUsage: normalizeUsage(field(sample, "executionTokenUsage")),
    },
    error: row.error,
    errorType: classifyErrorType(row.error, { existingType: row.errorType }),
    errorStage: row.errorStage,
    errorCode: row.errorCode,
    errorDetails: row.errorDetails,
    threadId: field(sample, "threadId") ?? null,
  });
}
function dominantFramework(results: readonly RedTeamResult[]) {
  const frameworks = new Set(results.map((result) => result.attack.framework));
  return frameworks.size === 1 ? [...frameworks][0] : null;
}
export function staticResultsToReport(
  results: readonly Record<string, unknown>[],
  options: StaticReportOptions = {},
): RedTeamReport {
  const unified = results.map((sample) =>
      staticSampleToResult(sample, options),
    ),
    errors = options.runErrors ?? [];
  return new RedTeamReport({
    createdAt: new Date(),
    description: options.description ?? null,
    pipeline: Pipeline.STATIC,
    framework: dominantFramework(unified),
    categoriesTested: [
      ...new Set(unified.map((result) => result.attack.category)),
    ].sort(codepointCompare),
    testedAgents: options.agentKey ? [options.agentKey] : [],
    totalResults: unified.length,
    errors,
    results: unified,
    summary: computeReportSummary(unified, { runErrors: errors }),
  });
}
function preExecutionError(result: unknown, inputs: unknown): RunError {
  const error =
      textError(field(result, "error")) ||
      "Datapoint failed before job execution (no strategy payload)",
    rowIndex = field(inputs, "rowIndex");
  return RunErrorSchema.parse({
    message: error,
    errorType: classifyErrorType(error) || "unknown",
    stage: "datapoint_generation",
    code: "datapoint_error",
    details: rowIndex != null ? { row_index: rowIndex } : null,
  });
}
export interface DynamicReportOptions {
  agentContext: AgentContext;
  results: readonly unknown[];
  durationSeconds?: number | null;
  description?: string | null;
  categoriesTested?: readonly string[];
  runId?: string | null;
}
export function dynamicEvaluatorqResultsToReport(
  options: DynamicReportOptions,
): RedTeamReport {
  const unified: RedTeamResult[] = [],
    errors: RunError[] = [];
  for (const result of options.results) {
    const dataPoint = field(result, "dataPoint");
    if (dataPoint == null) {
      console.warn(
        "Skipping dynamic result without a data point; recording as pre-execution run error",
      );
      errors.push(preExecutionError(result, {}));
      continue;
    }
    const inputs = field(dataPoint, "inputs") || {},
      parsedStrategy = AttackStrategySchema.safeParse(
        field(inputs, "strategy") || {},
      );
    if (!parsedStrategy.success) {
      console.warn(
        "Skipping report row with unparseable strategy payload; recording as run error",
      );
      errors.push(preExecutionError(result, inputs));
      continue;
    }
    const strategy = parsedStrategy.data,
      category = normalizeCategory(
        String(field(inputs, "category") ?? strategy.category),
      ),
      vulnerability =
        field(inputs, "vulnerability") || resolveCategorySafe(category) || "";
    const jobs = field(result, "jobResults"),
      job = Array.isArray(jobs) ? jobs[0] : null,
      output = coerceJobOutputPayload(field(job, "output"));
    const scores = field(job, "evaluatorScores"),
      firstScore = Array.isArray(scores) ? scores[0] : null,
      score = field(firstScore, "score");
    const evalValue = field(score, "value") ?? null,
      evalPassed = scorePassed(evalValue),
      evalRaw = field(score, "rawOutput") ?? null;
    const error =
      textError(field(result, "error")) ||
      textError(field(job, "error")) ||
      output.error;
    const meta = getEvaluatorMetadataForCategory(category),
      evaluatorId = meta?.evaluatorId ?? category,
      evaluatorName =
        meta?.evaluatorName ?? OWASP_CATEGORY_NAMES[category] ?? null;
    const definition = getVulnerabilityDef(
        strategy.vulnerability || resolveCategorySafe(category) || "",
      ),
      vulnerable = evalPassed === null ? null : !evalPassed;
    unified.push(
      new RedTeamResult({
        attack: {
          id: field(inputs, "id") ?? `${category}-${strategy.name}`,
          vulnerability,
          category,
          framework: inferFramework(category),
          attackTechnique: strategy.attackTechnique,
          deliveryMethods: strategy.deliveryMethods,
          turnType: strategy.turnType,
          severity: strategy.severity,
          vulnerabilityDomain: definition?.domain ?? null,
          source: strategy.isGenerated
            ? AttackSource.GENERATED_DYNAMIC
            : AttackSource.TEMPLATE_DYNAMIC,
          strategyName: strategy.name,
          objective: field(inputs, "objective") ?? null,
          evaluatorId,
          evaluatorName,
        },
        agent: {
          key: options.agentContext.key,
          model: options.agentContext.model,
          displayName: options.agentContext.displayName,
        },
        messages: output.conversation,
        response: job ? coerceJobOutputText(field(job, "output")) : "",
        evaluation: {
          value: evalValue,
          passed: evalPassed,
          explanation: field(score, "explanation") || "",
          evaluatorId,
          evaluatorName,
          tokenUsage: normalizeUsage(field(score, "tokenUsage")),
          rawOutput: withoutLifted(evalRaw),
          jury: extractJury(evalRaw),
        },
        vulnerable,
        evaluationError:
          extractEvaluationError(evalRaw) ||
          scorerError(field(firstScore, "error"), vulnerable),
        execution: {
          turns: output.turns ?? 1,
          maxTurns: output.maxTurns,
          durationSeconds: output.durationSeconds,
          objectiveAchieved: output.objectiveAchieved,
          objectiveRationale: output.objectiveRationale,
          tokenUsage: output.tokenUsage,
          tokenUsageBootstrap: output.tokenUsageBootstrap,
          seedContext: output.seedContext,
          backtrackedTurns: output.backtrackedTurns,
          refusalJudgeFailures: output.refusalJudgeFailures,
        },
        error,
        errorType: classifyErrorType(error, { existingType: output.errorType }),
        errorStage: output.errorStage,
        errorCode: output.errorCode,
        errorDetails: output.errorDetails,
        tokenUsageBootstrap: output.tokenUsageBootstrap,
        seedContext: output.seedContext,
        threadId: output.threadId,
        responseTraces: output.responseTraces,
      }),
    );
  }
  let categories = [
    ...new Set(unified.map((result) => result.attack.category)),
  ].sort(codepointCompare);
  if (!categories.length && options.categoriesTested?.length) {
    console.warn(
      "No results produced data points; falling back to requested categories",
    );
    categories = [
      ...new Set(options.categoriesTested.map(normalizeCategory)),
    ].sort(codepointCompare);
  }
  const agentKey =
    options.agentContext.key || options.agentContext.displayName || "unknown";
  return new RedTeamReport({
    createdAt: new Date(),
    description: options.description ?? null,
    pipeline: Pipeline.DYNAMIC,
    framework: dominantFramework(unified),
    categoriesTested: categories,
    testedAgents: [agentKey],
    totalResults: unified.length,
    errors,
    agentContexts: { [agentKey]: options.agentContext },
    results: unified,
    summary: computeReportSummary(unified, { runErrors: errors }),
    durationSeconds: options.durationSeconds ?? null,
    runId: options.runId ?? null,
  });
}
export function staticEvaluatorqResultsToReports(
  options: Omit<StaticReportOptions, "runErrors"> & {
    results: readonly unknown[];
  },
): Record<string, RedTeamReport> {
  const samples = new Map<string, Record<string, unknown>[]>(),
    errors = new Map<string, RunError[]>();
  for (const result of options.results) {
    const inputs = field(field(result, "dataPoint"), "inputs") || {},
      jobs = field(result, "jobResults");
    if (!Array.isArray(jobs) || !jobs.length) {
      console.warn(
        "Static result has no job results; recording as pre-execution run error",
      );
      const prior = errors.get("pre-execution") ?? [];
      prior.push(preExecutionError(result, inputs));
      errors.set("pre-execution", prior);
      continue;
    }
    const category = normalizeCategory(String(field(inputs, "category") ?? "")),
      meta = getEvaluatorMetadataForCategory(category),
      vulnerability = resolveCategorySafe(category) || "";
    const base = {
      input: {
        id: field(inputs, "id") ?? "",
        vulnerability,
        category: field(inputs, "category") ?? "",
        attackTechnique:
          field(inputs, "attackTechnique") ?? "indirect-injection",
        deliveryMethod: field(inputs, "deliveryMethod") ?? "direct-request",
        severity: field(inputs, "severity") ?? "medium",
        scope: field(inputs, "scope") ?? "application",
        framework: field(inputs, "framework") ?? "OWASP-AGENTIC",
        turnType: field(inputs, "turnType") ?? "single",
        source: field(inputs, "source") ?? AttackSource.ORQ_DATASET,
        evaluatorId: meta?.evaluatorId ?? category,
        evaluatorName:
          meta?.evaluatorName ??
          OWASP_CATEGORY_NAMES[String(field(inputs, "category") ?? "")] ??
          null,
      },
      messages: field(inputs, "messages") ?? [],
    };
    for (const job of jobs) {
      const name = String(field(job, "jobName")),
        raw = field(job, "output"),
        output = coerceJobOutputPayload(raw),
        scores = field(job, "evaluatorScores"),
        firstScore = Array.isArray(scores) ? scores[0] : null,
        score = field(firstScore, "score");
      const evaluationResult = firstScore
        ? {
            value: field(score, "value"),
            passed: scorePassed(field(score, "value")),
            explanation: field(score, "explanation") || "",
            evaluatorId: meta?.evaluatorId ?? category,
            evaluatorName:
              meta?.evaluatorName ??
              OWASP_CATEGORY_NAMES[String(field(inputs, "category") ?? "")] ??
              null,
            tokenUsage: field(score, "tokenUsage") ?? null,
            rawOutput: field(score, "rawOutput") ?? null,
            error: textError(field(firstScore, "error")),
          }
        : {};
      const error =
        textError(field(result, "error")) ||
        textError(field(job, "error")) ||
        output.error;
      const sample = {
        ...base,
        response: coerceJobOutputText(raw),
        error,
        errorType: classifyErrorType(error, { existingType: output.errorType }),
        errorStage: output.errorStage,
        errorCode: output.errorCode,
        errorDetails: output.errorDetails,
        threadId: output.threadId,
        executionTokenUsage: normalizeUsage(output.tokenUsage),
        evaluationResult,
      };
      const rows = samples.get(name) ?? [];
      rows.push(sample);
      samples.set(name, rows);
    }
  }
  return Object.fromEntries(
    [...new Set([...samples.keys(), ...errors.keys()])]
      .sort(codepointCompare)
      .map((name) => [
        name,
        staticResultsToReport(samples.get(name) ?? [], {
          ...options,
          description: `${options.description || "Static red teaming"} (${name})`,
          runErrors: errors.get(name),
        }),
      ]),
  );
}
