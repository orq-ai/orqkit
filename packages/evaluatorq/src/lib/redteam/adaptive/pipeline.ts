import type { Span } from "@opentelemetry/api";
import type OpenAI from "openai";

import { appendJurySummary, attachJuryRawOutput } from "../../common/jury.js";
import {
  coerceContentText,
  dropUnreplayableToolRecords,
} from "../../common/messages.js";
import { pythonStrip } from "../../common/sanitize.js";
import { callTargetWithRetry, closeTarget } from "../../common/target-call.js";
import {
  buildThreadId,
  conversationThread,
} from "../../common/thread-context.js";
import { setSpanAttrs, truncateForSpan } from "../../common/tracing.js";
import {
  type AgentContext,
  AgentResponse,
  type Message,
  toChatCompletion,
} from "../../contracts.js";
import { job } from "../../job-helper.js";
import type { DataPoint, Evaluator, Job } from "../../types.js";
import type { Backend } from "../backends/base.js";
import { createAsyncLlmClient } from "../backends/client.js";
import { resolveBackend } from "../backends/registry.js";
import {
  attackerModelFor,
  evaluatorModelFor,
  type LLMConfig,
  PIPELINE_CONFIG,
} from "../config.js";
import {
  TurnType,
  type Vulnerability,
  Vulnerability as VulnerabilityValues,
} from "../contracts.js";
import { AttackOutput, OrchestratorResult } from "../result.js";
import { AttackStrategySchema } from "../strategy.js";
import {
  parseTraceSeed,
  replaySeedContext,
  TRACE_SEED_MESSAGES_KEY,
  TRACE_START_FROM_KEY,
  TraceStart,
} from "../traces.js";
import {
  annotateCurrentSpan,
  setJurySpanAttrs,
  withRedteamSpan,
} from "../tracing.js";
import { Turn } from "../turn.js";
import {
  getPrimaryCategory,
  resolveCategorySafe,
  resolveVulnerabilities,
} from "../vulnerability-registry.js";
import { generateAttackPrompt, generateObjective } from "./attack-generator.js";
import { OWASPEvaluator, type OWASPEvaluatorOptions } from "./evaluator.js";
import { MultiTurnOrchestrator } from "./orchestrator.js";
import { mergeAttackUsage } from "./orchestrator-helpers.js";
import { getActiveProgress } from "./progress.js";
import {
  planStrategiesForCategories,
  planStrategiesForVulnerabilities,
  type StrategyPlanningOptions,
  type StrategySelection,
} from "./strategy-planner.js";

export function expandTraceSeedDatapoints(
  seeds: readonly DataPoint[] | null,
  dynamicDatapoints: DataPoint[],
): DataPoint[] {
  if (seeds === null) return dynamicDatapoints;
  return seeds.flatMap((seed, index) => {
    const slice: Record<string, unknown> = {};
    for (const key of [
      TRACE_SEED_MESSAGES_KEY,
      TRACE_START_FROM_KEY,
      "sourceTraceId",
    ]) {
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if (Object.hasOwn(seed.inputs, key)) slice[key] = seed.inputs[key];
      else if (Object.hasOwn(seed.inputs, snake))
        slice[key] = seed.inputs[snake];
    }
    return dynamicDatapoints.map((attack) => ({
      ...attack,
      inputs: {
        ...attack.inputs,
        ...slice,
        id: `trace_${slice.sourceTraceId || seed.inputs.id || "seed"}_${index}_${attack.inputs.id ?? "attack"}`,
      },
    }));
  });
}
export type DynamicDatapointOptions = Partial<
  Omit<StrategyPlanningOptions, "agentContext">
>;
export type DynamicDatapointMetadata = Record<
  string,
  StrategySelection | Record<string, never> | string[]
>;
function planningOptions(
  agentContext: AgentContext,
  options: DynamicDatapointOptions,
): StrategyPlanningOptions {
  return {
    ...options,
    agentContext,
    attackModel: attackerModelFor(options.attackModel, options.pipelineConfig),
    maxTurns: options.maxTurns ?? 5,
    maxPerCategory: options.maxPerCategory ?? null,
    generateAdditionalStrategies: options.generateAdditionalStrategies ?? true,
    generatedStrategyCount: options.generatedStrategyCount ?? 2,
    pipelineConfig: options.pipelineConfig ?? PIPELINE_CONFIG,
  };
}
export async function generateDynamicDatapointsForVulnerabilities(
  agentContext: AgentContext,
  vulnerabilities: Vulnerability[],
  options: DynamicDatapointOptions = {},
): Promise<[DataPoint[], DynamicDatapointMetadata]> {
  const [strategies, metadata] = await planStrategiesForVulnerabilities({
    ...planningOptions(agentContext, options),
    vulnerabilities,
  });
  const data = vulnerabilities.flatMap((vulnerability) =>
    (strategies[vulnerability] ?? []).map((strategy) => ({
      expectedOutput: null,
      inputs: {
        id: `dynamic_${vulnerability}_${strategy.name}`,
        vulnerability,
        category: getPrimaryCategory(vulnerability),
        strategy,
        objective: generateObjective(strategy, agentContext),
      },
    })),
  );
  return [data, metadata];
}
export async function generateDynamicDatapoints(
  agentContext: AgentContext,
  categories: string[],
  options: DynamicDatapointOptions = {},
): Promise<[DataPoint[], DynamicDatapointMetadata]> {
  let vulnerabilities: Vulnerability[] | null;
  try {
    vulnerabilities = resolveVulnerabilities(categories);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.warn(
      `Could not resolve all categories to vulnerabilities, falling back to category-based path: ${error}`,
    );
    vulnerabilities = null;
  }
  if (vulnerabilities !== null) {
    const [data, metadata] = await generateDynamicDatapointsForVulnerabilities(
      agentContext,
      vulnerabilities,
      options,
    );
    return [
      data,
      Object.fromEntries(
        categories.flatMap((category) => {
          const vulnerability = resolveCategorySafe(category);
          return vulnerability && Object.hasOwn(metadata, vulnerability)
            ? [[category, metadata[vulnerability]]]
            : [];
        }),
      ) as DynamicDatapointMetadata,
    ];
  }
  const [strategies, selected] = await planStrategiesForCategories({
    ...planningOptions(agentContext, options),
    categories,
  });
  const metadata: DynamicDatapointMetadata = { ...selected },
    data = categories.flatMap((category) =>
      (strategies[category] ?? []).map((strategy) => ({
        expectedOutput: null,
        inputs: {
          id: `dynamic_${category}_${strategy.name}`,
          vulnerability: strategy.vulnerability || "",
          category,
          strategy,
          objective: generateObjective(strategy, agentContext),
        },
      })),
    );
  const empty = categories.filter((category) => !strategies[category]?.length);
  if (empty.length) metadata._unresolved_categories = empty;
  return [data, metadata];
}
function setAttackSpanAttrs(
  span: Span | undefined,
  output: AttackOutput,
): void {
  setSpanAttrs(span, {
    "orq.redteam.objective_achieved": output.objectiveAchieved,
    "orq.redteam.actual_turns": output.nTurns,
    "orq.redteam.duration_seconds": output.durationSeconds,
  });
  if (output.objectiveRationale)
    setSpanAttrs(span, {
      "orq.redteam.objective_rationale": Array.from(output.objectiveRationale)
        .slice(0, 500)
        .join(""),
    });
  if (output.error)
    setSpanAttrs(span, {
      "orq.redteam.error_type": output.errorType,
      "orq.redteam.error_code": output.errorCode,
    });
}
function safeAgentKey(key: string): string {
  return key.replace(/[^\p{L}\p{N}_-]/gu, "-").replace(/^-+|-+$/g, "");
}
export interface DynamicRedteamJobOptions {
  agentKey: string;
  jobLabel?: string;
  agentContext: AgentContext;
  redTeamModel?: string | null;
  maxTurns?: number;
  backend?: Backend;
  attackLlmClient?: OpenAI;
  memoryEntityIds?: string[];
  attackerInstructions?: string | null;
  verbosity?: number;
  llmKwargs?: Record<string, unknown> | null;
  pipelineConfig?: LLMConfig | null;
  runId?: string | null;
  signal?: AbortSignal;
}
export function createDynamicRedteamJob(
  options: DynamicRedteamJobOptions,
): Job {
  const cfg = options.pipelineConfig ?? PIPELINE_CONFIG,
    model = attackerModelFor(options.redTeamModel, cfg),
    backend = options.backend ?? resolveBackend("orq", { pipelineConfig: cfg });
  const safeKey = safeAgentKey(options.jobLabel ?? options.agentKey);
  return job(`redteam:dynamic:${safeKey || "agent"}`, async (data, row) => {
    options.signal?.throwIfAborted();
    if (
      !Object.hasOwn(data.inputs, "objective") ||
      !Object.hasOwn(data.inputs, "category")
    )
      throw new TypeError(
        "Dynamic attack inputs require objective and category",
      );
    const inputs = { ...data.inputs },
      strategy = AttackStrategySchema.parse(inputs.strategy),
      objective = String(inputs.objective),
      category = String(inputs.category),
      vulnerability = String(inputs.vulnerability ?? "");
    const maxTurns =
        strategy.turnType === TurnType.SINGLE ? 1 : (options.maxTurns ?? 5),
      threadId = buildThreadId(options.runId, safeKey, row);
    return withRedteamSpan(
      "orq.redteam.attack",
      {
        "orq.redteam.category": category,
        "orq.redteam.vulnerability": vulnerability,
        "orq.redteam.strategy_name": strategy.name,
        "orq.redteam.turn_type": strategy.turnType,
        "orq.redteam.max_turns": maxTurns,
      },
      async (attackSpan) => {
        const target = backend.createTarget(options.agentKey);
        try {
          if (target.memoryEntityId !== null)
            options.memoryEntityIds?.push(target.memoryEntityId);
          if ("model" in target && options.agentContext.model)
            Object.assign(target, { model: options.agentContext.model });
          const [seedMessages, traceStartFrom] = parseTraceSeed(inputs, {
            label: "datapoint",
            required: false,
          });
          return await conversationThread(threadId, async (actualThreadId) => {
            if (
              strategy.promptTemplate &&
              strategy.turnType === TurnType.SINGLE
            ) {
              const started = Date.now(),
                prompt = generateAttackPrompt(strategy, options.agentContext);
              let seedContext: Message[] = [],
                bootstrapUsage = null;
              if (seedMessages !== null) {
                const [seed, usage, error] = await replaySeedContext(
                  target,
                  seedMessages,
                  traceStartFrom ?? TraceStart.FIRST_USER,
                  {
                    targetAgentTimeoutMs: cfg.targetAgentTimeoutMs,
                    maxTargetRetries: cfg.maxTargetRetries,
                    mapError: (error) => backend.mapError(error),
                    signal: options.signal,
                  },
                );
                seedContext = seed;
                bootstrapUsage = usage;
                if (error !== null) {
                  const output = new AttackOutput({
                    turns: [],
                    objectiveAchieved: false,
                    durationSeconds: (Date.now() - started) / 1000,
                    tokenUsage: usage,
                    tokenUsageBootstrap: usage,
                    seedContext,
                    maxTurns,
                    ...error,
                    category,
                    vulnerability,
                  });
                  setAttackSpanAttrs(attackSpan, output);
                  await getActiveProgress()?.finishAttack(null);
                  return {
                    ...output.toJSON(),
                    turns: 0,
                    maxTurns,
                    threadId: actualThreadId,
                  };
                }
              }
              const result = await callTargetWithRetry(
                target,
                [
                  ...seedContext,
                  {
                    role: "user",
                    content: prompt,
                    tool_calls: null,
                    tool_call_id: null,
                    name: null,
                  },
                ],
                {
                  targetAgentTimeoutMs: cfg.targetAgentTimeoutMs,
                  maxTargetRetries: cfg.maxTargetRetries,
                  signal: options.signal,
                  mapError: (error) => backend.mapError(error),
                  onAttempt: (attempt, run) =>
                    withRedteamSpan(
                      "orq.redteam.target_call",
                      {
                        "orq.redteam.category": category,
                        "orq.redteam.strategy_name": strategy.name,
                        "orq.redteam.turn": 1,
                        "orq.redteam.target_attempt": attempt + 1,
                        input: truncateForSpan(prompt),
                        "orq.redteam.input": truncateForSpan(prompt),
                      },
                      run,
                    ),
                  onAttemptResponse: (span, response) =>
                    setSpanAttrs(span as Span | undefined, {
                      output: truncateForSpan(response.text || ""),
                      "orq.redteam.output": truncateForSpan(
                        response.text || "",
                      ),
                    }),
                },
              );
              const response = result.response,
                usage = result.succeeded ? response.usage : null;
              const output = new AttackOutput({
                turns: [
                  new Turn({
                    attacker: new AgentResponse({ text: prompt }),
                    target: response.output.length
                      ? response
                      : new AgentResponse({ text: response.text || "" }),
                  }),
                ],
                objectiveAchieved: false,
                durationSeconds: (Date.now() - started) / 1000,
                tokenUsage: mergeAttackUsage(usage, bootstrapUsage),
                tokenUsageTarget: usage,
                tokenUsageBootstrap: bootstrapUsage,
                seedContext,
                ...result.errorPayload(),
                category,
                vulnerability,
              });
              setSpanAttrs(attackSpan, {
                input: truncateForSpan(prompt),
                output: truncateForSpan(response.text || ""),
              });
              setAttackSpanAttrs(attackSpan, output);
              await getActiveProgress()?.finishAttack(null);
              return { ...output.toJSON(), maxTurns, threadId: actualThreadId };
            }
            const client =
              options.attackLlmClient ??
              (await createAsyncLlmClient(cfg.attacker));
            const orchestrator = new MultiTurnOrchestrator(client, {
              model,
              backend,
              attackerInstructions: options.attackerInstructions,
              verbosity: options.verbosity,
              llmKwargs: options.llmKwargs,
              pipelineConfig: cfg,
            });
            let result: OrchestratorResult;
            try {
              result = await orchestrator.runAttack(
                target,
                strategy,
                objective,
                options.agentContext,
                maxTurns,
                { seedMessages, traceStartFrom, signal: options.signal },
              );
            } catch (error) {
              if (
                options.signal?.aborted ||
                [
                  "AbortError",
                  "TypeError",
                  "ReferenceError",
                  "RangeError",
                  "SyntaxError",
                ].includes((error as Error)?.name)
              )
                throw error;
              const mapped = backend.mapError(error),
                timeout = (error as Error)?.name === "TimeoutError";
              console.error(
                `${timeout ? "Orchestrator timed out" : "Unexpected orchestrator error"} for ${category}/${strategy.name}: ${mapped.message}`,
              );
              result = new OrchestratorResult({
                error: `${timeout ? "Orchestrator timeout" : "Unexpected orchestrator error"}: ${mapped.message}`,
                errorType: timeout
                  ? "orchestrator_timeout"
                  : "orchestrator_exception",
                errorStage: "orchestrator",
                errorCode: mapped.code,
                errorDetails: {
                  exception_type:
                    error instanceof Error
                      ? error.constructor.name
                      : typeof error,
                  raw_message:
                    error instanceof Error ? error.message : String(error),
                  traceback: error instanceof Error ? (error.stack ?? "") : "",
                },
              });
            }
            const output = new AttackOutput({
              ...result.toJSON(),
              category,
              vulnerability,
            });
            const firstUser = output.chatCompletions.find(
              (message) => message.role === "user",
            )?.content;
            if (firstUser)
              setSpanAttrs(attackSpan, { input: truncateForSpan(firstUser) });
            if (output.finalResponse)
              setSpanAttrs(attackSpan, {
                output: truncateForSpan(output.finalResponse),
              });
            setAttackSpanAttrs(attackSpan, output);
            const payload = output.toJSON();
            if (
              seedMessages !== null &&
              output.error !== null &&
              !output.turns.length
            )
              payload.turns = 0;
            return { ...payload, maxTurns, threadId: actualThreadId };
          });
        } finally {
          await closeTarget(target);
        }
      },
    );
  });
}
const turnHasContent = (turn: Turn) =>
  turn.target.output.some(
    (item) =>
      item.type === "function_call" ||
      (item.type === "output_text" && !!pythonStrip(item.text)),
  );
export function createDynamicEvaluator(
  options: OWASPEvaluatorOptions & { judgeRepetitions?: number } = {},
): Evaluator & { evaluatorType: "llm_eval" } {
  const model = evaluatorModelFor(options.evaluatorModel, options.cfg),
    evaluator = new OWASPEvaluator({
      ...options,
      evaluatorModel: model,
      repetitions: options.judgeRepetitions ?? options.repetitions ?? 1,
    });
  return {
    name: "owasp-dynamic-security",
    evaluatorType: "llm_eval",
    scorer: async ({ data, output: raw }) => {
      let output: AttackOutput;
      if (raw instanceof AttackOutput) output = raw;
      else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        try {
          output = new AttackOutput(raw as Record<string, unknown>);
        } catch (error) {
          console.error(
            `Failed to parse job output as AttackOutput (datapoint ${String(data.inputs.id ?? "<unknown>")}): ${error}`,
          );
          return {
            value: "error",
            explanation: `Failed to parse job output: ${error}`,
          };
        }
      } else {
        console.warn(
          `Unexpected job output type ${typeof raw}; treating as error`,
        );
        return {
          value: "error",
          explanation: `Unexpected job output type: ${typeof raw}`,
        };
      }
      if (output.error)
        return {
          value: "error",
          explanation: `Skipped: incomplete attack run - ${output.error}`,
        };
      const category = output.category || String(data.inputs.category || ""),
        vulnerability =
          output.vulnerability || String(data.inputs.vulnerability || "");
      if (!output.turns.length)
        return {
          value: "inconclusive",
          explanation:
            "Skipped: target produced no responses, so there is no evidence to evaluate.",
        };
      const scorable = output.turns.filter(
        (turn) => !turn.errored && turnHasContent(turn),
      );
      if (scorable.length !== output.turns.length) {
        const codes =
          [
            ...new Set(
              output.turns.flatMap((turn) =>
                turn.target.error?.code ? [turn.target.error.code] : [],
              ),
            ),
          ]
            .sort()
            .join(", ") || "none";
        return {
          value: output.turns.some((turn) => turn.errored)
            ? "error"
            : "inconclusive",
          explanation: `Skipped: incomplete target transcript (errored or empty; codes: ${codes}) - nothing to evaluate`,
        };
      }
      const seed = dropUnreplayableToolRecords(output.seedContext, {
        incompleteAsText: true,
      }).map((message) => ({
        ...toChatCompletion(message),
        content: `[imported trace context] ${coerceContentText(message.content)}`,
      }));
      const inputMessages = [
          ...seed,
          ...scorable.map((turn) => ({
            role: "user",
            content: turn.attacker.text,
          })),
        ],
        outputMessages = scorable.flatMap((turn) => turn.target.output);
      const resolved = (
        Object.values(VulnerabilityValues) as string[]
      ).includes(vulnerability)
        ? (vulnerability as Vulnerability)
        : resolveCategorySafe(vulnerability);
      const result = await annotateCurrentSpan(
        {
          "orq.redteam.category": category,
          "orq.redteam.vulnerability": vulnerability,
          "orq.redteam.model": model,
        },
        async (span) => {
          const result = resolved
            ? await evaluator.evaluateVulnerability(
                resolved,
                inputMessages,
                outputMessages,
              )
            : await evaluator.evaluate(category, inputMessages, outputMessages);
          setSpanAttrs(span, {
            "orq.redteam.passed": result.passed,
            input: output.finalResponse || "",
            output: result.explanation || "",
          });
          setJurySpanAttrs(span, result.jury);
          return result;
        },
      );
      return {
        value: result.passed ?? "inconclusive",
        explanation: appendJurySummary(result.explanation, result.jury),
        pass: result.passed,
        tokenUsage: result.tokenUsage,
        rawOutput: attachJuryRawOutput(result.rawOutput, result.jury) ?? null,
      };
    },
  };
}

export async function cleanupMemoryEntities(
  agentContext: AgentContext,
  entityIds: string[],
  options: { memoryCleanup?: Backend; pipelineConfig?: LLMConfig | null } = {},
): Promise<string | null> {
  const cfg = options.pipelineConfig ?? PIPELINE_CONFIG,
    controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined,
    timedOut = false;
  try {
    const backend = options.memoryCleanup ?? resolveBackend("orq");
    await Promise.race([
      backend.cleanupMemory(agentContext, entityIds, {
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            controller.abort();
            reject(new Error("Cleanup timeout"));
          },
          Math.max(0, cfg.cleanupTimeoutMs),
        );
      }),
    ]);
    return null;
  } catch (error) {
    const message = timedOut
      ? `Memory cleanup timed out after ${(cfg.cleanupTimeoutMs / 1000).toFixed(0)}s for ${entityIds.length} entities`
      : `Memory cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(message);
    return message;
  } finally {
    clearTimeout(timer);
  }
}
