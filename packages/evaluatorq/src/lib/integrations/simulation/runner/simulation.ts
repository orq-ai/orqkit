import { pairToolRows, toolCallText } from "../../../common/messages.js";

/**
 * Simulation runner for orchestrating agent conversations.
 *
 * Manages the simulation loop between user simulator, target agent,
 * and judge agent.
 */

/**
 * Simulation runner for orchestrating agent conversations.
 *
 * Manages the simulation loop between user simulator, target agent,
 * and judge agent.
 */

import type OpenAI from "openai";

import { sumStructuredUsage } from "../../../common/structured-output.js";
import {
  callTargetWithRetry,
  closeTarget,
  extractStatusCode,
  type TargetCallResult,
} from "../../../common/target-call.js";
import {
  type AgentResponse,
  type AgentTarget,
  addUsage,
  type LLMCallConfig,
  MessageSchema,
  renderToolCall,
  type Usage,
} from "../../../contracts.js";
import type { AgentCallOptions } from "../agents/base.js";
import { JudgeAgent } from "../agents/judge.js";
import { UserSimulatorAgent } from "../agents/user-simulator.js";
import { createRouterClient } from "../client.js";
import { resolveSimLlmConfig, simRoleConfig } from "../config.js";
import { inConversation } from "../conversation.js";
import {
  buildCriteriaMeta,
  buildCriteriaResults,
  CriteriaTracker,
} from "../criteria.js";
import type { SimulationHooks } from "../hooks.js";
import {
  recordLLMInput,
  recordLLMOutput,
  recordTokenUsage,
  setSpanAttrs,
  withSimulationSpan,
} from "../tracing.js";
import type {
  ChatMessage,
  Datapoint,
  Judgment,
  Persona,
  Scenario,
  SimulationResult,
  TargetCallback,
  TokenUsage,
  TurnMetrics,
} from "../types.js";
import { usageDelta, usageDetails } from "../usage.js";
import {
  buildDatapointSystemPrompt,
  buildPersonaSystemPrompt,
  buildScenarioUserContext,
} from "../utils/prompt-builders.js";

// ---------------------------------------------------------------------------
// Protocols / interfaces
// ---------------------------------------------------------------------------

/** Protocol for target agents being tested. */
export interface TargetAgent {
  readonly managesOwnTimeout?: boolean;
  readonly timeoutMs?: number;
  respond(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<string | AgentResponse>;
  newInstance?(): TargetAgent;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SimulationUserSimulator {
  updateContext(personaContext?: string, scenarioContext?: string): void;
  generateFirstMessage(
    messages?: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string>;
  respondAsync(
    messages: ChatMessage[],
    options?: AgentCallOptions,
  ): Promise<string>;
  getUsage(): TokenUsage;
  getUsageDetails?(): Usage | null;
  resetUsage(): void;
}
export interface SimulationJudge {
  evaluate(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<Judgment>;
  getUsage(): TokenUsage;
  getUsageDetails?(): Usage | null;
  resetUsage(): void;
  updateContext?(context: {
    goal?: string;
    criteria?: import("../types.js").Criterion[];
    groundTruth?: string;
  }): void;
  markSettled?(ids: Iterable<string>): void;
}

const injectedRuns = new WeakMap<object, Promise<void>>();

async function untilAborted<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return task;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Simulation cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([task, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function reserveInjectedAgents(agents: object[]) {
  const ready = Promise.all(agents.map((agent) => injectedRuns.get(agent)));
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = ready.then(() => finished);
  for (const agent of agents) injectedRuns.set(agent, held);
  return {
    ready,
    release: () => {
      release();
      for (const agent of agents)
        if (injectedRuns.get(agent) === held) injectedRuns.delete(agent);
    },
  };
}

export interface SimulationRunnerConfig {
  targetAgent?: TargetAgent | AgentTarget;
  llmConfig?: LLMCallConfig;
  userSimulator?: SimulationUserSimulator;
  judge?: SimulationJudge;
  hooks?: SimulationHooks;
  targetAgentTimeoutMs?: number;
  maxTargetRetries?: number;
  maxToolResultChars?: number;
  onFatalError?: (error: unknown) => void;
  signal?: AbortSignal;
  targetCallback?: TargetCallback;
  model?: string;
  maxTurns?: number;
  /** Pre-configured client to reuse. The runner does not close it. */
  client?: OpenAI;
}

export interface RunParams {
  persona?: Persona;
  scenario?: Scenario;
  datapoint?: Datapoint;
  maxTurns?: number;
  firstMessage?: string;
  /** Abort signal for cancellation (used by timeout). */
  signal?: AbortSignal;
}

export interface RunBatchParams {
  datapoints: Datapoint[];
  maxTurns?: number;
  /** Timeout per simulation in milliseconds. Default: 300_000 (5 min). */
  timeoutPerSimulation?: number;
  /** Maximum concurrent simulations. Default: 10. */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Helpers: create SimulationResult variants
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

function simulationMetadata(
  persona?: Persona,
  scenario?: Scenario,
): Record<string, unknown> {
  return {
    persona: persona?.name ?? null,
    scenario: scenario?.name ?? null,
    criteria_meta: null,
    ...(persona
      ? {
          persona_traits: {
            patience: persona.patience,
            assertiveness: persona.assertiveness,
            politeness: persona.politeness,
            technical_level: persona.technical_level,
            communication_style: persona.communication_style,
            background: persona.background,
          },
        }
      : {}),
    ...(scenario
      ? {
          scenario_goal: scenario.goal,
          scenario_context: scenario.context ?? "",
        }
      : {}),
  };
}

export function errorResult(
  reason: string,
  persona?: Persona,
  scenario?: Scenario,
): SimulationResult {
  return {
    messages: [],
    terminated_by: "error",
    reason,
    goal_achieved: false,
    goal_completion_score: 0,
    rules_broken: [],
    turn_count: 0,
    turn_metrics: [],
    token_usage_known: false,
    token_usage: { ...ZERO_USAGE },
    metadata: {
      ...simulationMetadata(persona, scenario),
      error: reason,
    },
  };
}

/** The same result, marked as having hit the row's time limit. */
export function timedOutResult(
  result: SimulationResult,
  timeoutMs: number,
): SimulationResult {
  const reason = `Simulation timed out after ${timeoutMs}ms`;
  return {
    ...result,
    terminated_by: "timeout",
    reason,
    metadata: {
      ...result.metadata,
      // failureReason prefers metadata.error, which may still say
      // "Simulation cancelled" from the aborted run.
      error: reason,
      timeout: timeoutMs,
    },
  };
}

/**
 * Swap user and assistant for the user simulator's LLM call.
 *
 * The simulator speaks as the assistant role in its own conversation, so the
 * target's replies must reach it as user turns. Without the swap the model
 * sees itself as the support agent and answers as one.
 */
export function invertRolesForSimulator(
  messages: ChatMessage[],
  maxToolResultChars = 500,
): ChatMessage[] {
  const pairing = pairToolRows(
    messages.map((message) => MessageSchema.parse(message)),
  );
  return messages.flatMap((message, index): ChatMessage[] => {
    if (message.role === "tool") return [];
    if (message.role === "user")
      return [{ role: "assistant", content: message.content }];
    if (message.role !== "assistant") return [{ ...message }];
    let content = message.content;
    if (!content && message.tool_calls?.length) {
      const answered = pairing.resultsFor(index);
      const calls = message.tool_calls.map((call, position) => {
        const row = answered.get(position);
        const result = row === undefined ? undefined : messages[row]?.content;
        const capped =
          result && Array.from(result).length > maxToolResultChars
            ? Array.from(result).slice(0, maxToolResultChars).join("") +
              "… (truncated)"
            : result;
        return toolCallText(call, {
          result: capped,
          incomplete: result === undefined,
        });
      });
      content = `[The agent used tools instead of replying]\n${calls.join("\n")}`;
    }
    return [{ role: "user", content }];
  });
}

function maxTurnsResult(
  maxTurns: number,
  messages: ChatMessage[],
  turnMetrics: TurnMetrics[],
  tokenUsage: TokenUsage,
  tracker: CriteriaTracker,
  persona?: Persona,
  scenario?: Scenario,
  lastJudgment?: Judgment,
): SimulationResult {
  const rulesBroken = tracker.resolve(lastJudgment?.rules_broken ?? []);
  return {
    messages,
    terminated_by: "max_turns",
    reason: `Maximum turns (${maxTurns}) reached`,
    goal_achieved: lastJudgment?.goal_achieved ?? false,
    goal_completion_score: lastJudgment?.goal_completion_score ?? 0,
    rules_broken: rulesBroken,
    turn_count: maxTurns,
    turn_metrics: turnMetrics,
    token_usage: tokenUsage,
    criteria_results: buildCriteriaResults(scenario, rulesBroken),
    criteria_verified: tracker.verified,
    metadata: {
      ...simulationMetadata(persona, scenario),
      criteria_meta: buildCriteriaMeta(
        scenario,
        rulesBroken,
        tracker.hasAudit ? tracker.auditedIds : null,
        tracker.hasAudit ? tracker.evidence : null,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// SimulationRunner
// ---------------------------------------------------------------------------

export class SimulationRunner {
  private readonly targetAgent?: TargetAgent | AgentTarget;
  private readonly config: SimulationRunnerConfig;
  private readonly llmConfig: LLMCallConfig;
  private readonly targetCallback?: TargetCallback;
  private readonly model: string;
  private readonly maxTurns: number;
  private sharedClient: OpenAI | null = null;
  private readonly injectedClient?: OpenAI;

  constructor(config: SimulationRunnerConfig) {
    if (!config.targetAgent && !config.targetCallback) {
      throw new Error("Must provide either targetAgent or targetCallback");
    }
    const maxTurns = config.maxTurns ?? 10;
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error(`maxTurns must be >= 1, got ${maxTurns}`);
    }
    this.config = config;
    this.llmConfig = resolveSimLlmConfig(config, "SimulationRunner");
    const model = simRoleConfig(this.llmConfig, "sim.user").model;
    if (!model.trim()) {
      throw new Error("model must be a non-empty string");
    }

    this.targetAgent = config.targetAgent;
    this.targetCallback = config.targetCallback;
    this.model = model;
    this.maxTurns = maxTurns;
    this.injectedClient = this.llmConfig.client as OpenAI | undefined;
    for (const [name, value, methods] of [
      [
        "userSimulator",
        config.userSimulator,
        [
          "updateContext",
          "generateFirstMessage",
          "respondAsync",
          "getUsage",
          "resetUsage",
        ],
      ],
      ["judge", config.judge, ["evaluate", "getUsage", "resetUsage"]],
    ] as const) {
      if (
        value &&
        methods.some(
          (method) =>
            typeof (value as unknown as Record<string, unknown>)[method] !==
            "function",
        )
      )
        throw new TypeError(`${name} must implement ${methods.join(", ")}`);
      if (value && this.llmConfig.fieldsSet.size)
        console.warn(
          `llmConfig does not apply to the injected ${name}; configure that agent directly`,
        );
    }
    for (const [name, value, minimum] of [
      ["targetAgentTimeoutMs", config.targetAgentTimeoutMs, 1],
      ["maxTargetRetries", config.maxTargetRetries, 0],
      ["maxToolResultChars", config.maxToolResultChars, 1],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < minimum))
        throw new Error(`${name} must be an integer >= ${minimum}`);
    }
  }

  get resolvedModel(): string {
    return this.model;
  }

  private getSharedClient(): OpenAI {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    this.sharedClient ??= createRouterClient();
    return this.sharedClient;
  }

  /** Run a single simulation. Never throws -- returns error SimulationResult on failure. */
  async run(params: RunParams): Promise<SimulationResult> {
    let persona: Persona | undefined = params.persona;
    let scenario: Scenario | undefined = params.scenario;
    let firstMessage: string | undefined = params.firstMessage;
    let storedSystemPrompt: string | undefined;
    const signal =
      this.config.signal && params.signal
        ? AbortSignal.any([this.config.signal, params.signal])
        : (this.config.signal ?? params.signal);
    const conversation = {};

    // Resolve datapoint
    if (params.datapoint) {
      persona = params.datapoint.persona;
      scenario = params.datapoint.scenario;
      firstMessage =
        firstMessage ?? (params.datapoint.first_message || undefined);
      storedSystemPrompt = params.datapoint.user_system_prompt || undefined;
    } else if (!persona || !scenario) {
      return errorResult(
        "Must provide either datapoint or both persona and scenario",
        persona,
        scenario,
      );
    }

    const maxTurns = params.maxTurns ?? this.maxTurns;

    const messages: ChatMessage[] = [];
    const turnMetricsList: TurnMetrics[] = [];

    // Declare usage helper references : initialized inside try after agents are created
    let getTotalUsage: (() => TokenUsage) | undefined;
    let usageKnown = false;
    let targetModel: string | null = null;

    let target = this.targetAgent;
    const targetUsage = { ...ZERO_USAGE };
    let detailedTargetUsage: Usage | null = null;
    let detailedUsage: Usage | null = null;
    const responseTraces: { traceId: string; spanId?: string | null }[] = [];
    let tracker: CriteriaTracker;
    try {
      tracker = new CriteriaTracker(scenario);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return errorResult(
        `Invalid scenario criteria: ${reason}`,
        persona,
        scenario,
      );
    }

    const pendingExternal: Promise<unknown>[] = [];
    const external = <T>(work: () => T | Promise<T>): Promise<T> => {
      signal?.throwIfAborted();
      const task = Promise.resolve().then(work);
      pendingExternal.push(task);
      return untilAborted(task, signal);
    };
    const reservation = reserveInjectedAgents([
      ...(this.config.userSimulator ? [this.config.userSimulator] : []),
      ...(this.config.judge ? [this.config.judge] : []),
    ]);
    try {
      await untilAborted(reservation.ready, signal);
      signal?.throwIfAborted();
      if (target?.newInstance) target = target.newInstance();
      if (params.datapoint)
        await external(() =>
          this.config.hooks?.onDatapointStart?.(params.datapoint as Datapoint),
        );
      const result = await withSimulationSpan<SimulationResult>(
        "orq.simulation.run",
        {
          "orq.simulation.persona": persona?.name,
          "orq.simulation.scenario": scenario?.name,
          "orq.simulation.max_turns": maxTurns,
          "orq.simulation.model": this.model,
        },
        async (runSpan) => {
          // Use stored system prompt if available, otherwise build from persona+scenario
          const systemPrompt =
            storedSystemPrompt ??
            buildDatapointSystemPrompt(
              persona as Persona,
              scenario as Scenario,
            );

          const client =
            !this.config.userSimulator || !this.config.judge
              ? this.getSharedClient()
              : undefined;

          const userSimulator = this.config.userSimulator
            ? this.config.userSimulator
            : new UserSimulatorAgent({
                llmConfig: this.llmConfig,
                client,
                systemPrompt: systemPrompt,
              });

          const judge = this.config.judge
            ? this.config.judge
            : new JudgeAgent({
                llmConfig: this.llmConfig,
                client,
                goal: scenario?.goal,
                criteria: scenario?.criteria ?? [],
                groundTruth: scenario?.ground_truth ?? "",
              });

          if (this.config.userSimulator) {
            userSimulator.resetUsage();
            userSimulator.updateContext(
              buildPersonaSystemPrompt(persona as Persona),
              buildScenarioUserContext(scenario as Scenario),
            );
          }
          if (this.config.judge) {
            judge.resetUsage();
            judge.updateContext?.({
              goal: scenario?.goal,
              criteria: scenario?.criteria ?? [],
              groundTruth: scenario?.ground_truth ?? "",
            });
          }
          let lastUsage: TokenUsage = { ...ZERO_USAGE };
          getTotalUsage = (): TokenUsage => {
            try {
              const usage = { ...userSimulator.getUsage() };
              const judgeUsage = judge.getUsage();
              detailedUsage = sumStructuredUsage([
                usageDetails(usage, userSimulator.getUsageDetails?.()),
                usageDetails(judgeUsage, judge.getUsageDetails?.()),
                detailedTargetUsage,
              ]);
              usage.prompt_tokens +=
                judgeUsage.prompt_tokens + targetUsage.prompt_tokens;
              usage.completion_tokens +=
                judgeUsage.completion_tokens + targetUsage.completion_tokens;
              usage.total_tokens +=
                judgeUsage.total_tokens + targetUsage.total_tokens;
              usageKnown = true;
              lastUsage = usage;
            } catch (error) {
              usageKnown = false;
              console.warn(
                "Unable to determine complete simulation token usage",
                error,
              );
            }
            return { ...lastUsage };
          };

          const buildTurnMetrics = (
            turnNum: number,
            judgment: Judgment,
            usageBefore: TokenUsage,
            detailedBefore: Usage | null,
          ): TurnMetrics => {
            const usageAfter = (getTotalUsage as () => TokenUsage)();
            return {
              turn_number: turnNum,
              usage: detailedUsage
                ? usageDelta(detailedUsage, detailedBefore)
                : null,
              token_usage: {
                prompt_tokens:
                  usageAfter.prompt_tokens - usageBefore.prompt_tokens,
                completion_tokens:
                  usageAfter.completion_tokens - usageBefore.completion_tokens,
                total_tokens:
                  usageAfter.total_tokens - usageBefore.total_tokens,
              },
              response_quality: judgment.response_quality ?? null,
              hallucination_risk: judgment.hallucination_risk ?? null,
              tone_appropriateness: judgment.tone_appropriateness ?? null,
              factual_accuracy: judgment.factual_accuracy ?? null,
              judge_reason: judgment.reason,
            };
          };

          /** Check if this run has been cancelled (timeout). */
          const checkCancelled = (): void => {
            if (signal?.aborted) {
              throw new Error("Simulation cancelled");
            }
          };

          checkCancelled();

          // Generate or use first message
          const firstMsg = firstMessage
            ? firstMessage
            : await withSimulationSpan(
                "orq.simulation.first_message_generation",
                {
                  "orq.simulation.persona": persona?.name,
                  "orq.simulation.scenario": scenario?.name,
                  "orq.simulation.model": this.model,
                },
                async () =>
                  external(() =>
                    userSimulator.generateFirstMessage(undefined, signal),
                  ),
              );
          messages.push({ role: "user", content: firstMsg });

          let lastJudgment: Judgment | undefined;

          for (let turn = 0; turn < maxTurns; turn++) {
            checkCancelled();
            const usageBefore = getTotalUsage();
            const detailedBefore = detailedUsage;

            await withSimulationSpan(
              "orq.simulation.turn",
              {
                "orq.simulation.turn": turn + 1,
                "orq.simulation.max_turns": maxTurns,
              },
              async (turnSpan) => {
                if (turn > 0) {
                  checkCancelled();
                  const userResponse = await withSimulationSpan(
                    "orq.simulation.user_simulator_call",
                    undefined,
                    async () =>
                      external(() =>
                        userSimulator.respondAsync(
                          invertRolesForSimulator(
                            messages,
                            this.config.maxToolResultChars,
                          ),
                          { signal, llmPurpose: "user_simulator" },
                        ),
                      ),
                  );
                  messages.push({ role: "user", content: userResponse });
                }
                // 1. Target agent responds
                const targetMessages = messages.map((m) => ({ ...m }));
                const targetCall = await withSimulationSpan(
                  "orq.simulation.target_call",
                  undefined,
                  async (targetSpan) => {
                    recordLLMInput(targetSpan, targetMessages);
                    const response = await this.getTargetResponse(
                      targetMessages,
                      conversation,
                      signal,
                      target,
                      (response) => {
                        if (response.usage) {
                          detailedTargetUsage = detailedTargetUsage
                            ? addUsage(detailedTargetUsage, response.usage)
                            : response.usage;
                          targetUsage.prompt_tokens +=
                            response.usage.inputTokens;
                          targetUsage.completion_tokens +=
                            response.usage.outputTokens;
                          targetUsage.total_tokens +=
                            response.usage.totalTokens;
                        }
                        if (response.model && targetModel === null)
                          targetModel = response.model;
                        if (response.traceId)
                          responseTraces.push({
                            traceId: response.traceId,
                            spanId: response.spanId,
                          });
                      },
                    );
                    recordLLMOutput(targetSpan, response.response.text);
                    return response;
                  },
                );
                const agentResponse = targetCall.response;
                const rendered = agentResponse.toolCalls.map(renderToolCall);
                messages.push({
                  role: "assistant",
                  content: agentResponse.text,
                  ...(rendered.length
                    ? { tool_calls: rendered.map((item) => item.toolCall) }
                    : {}),
                });
                for (const item of rendered)
                  if (item.toolMessage)
                    messages.push({
                      ...item.toolMessage,
                      content: item.toolMessage.content as string,
                    });

                if (!targetCall.succeeded) {
                  const payload = targetCall.errorPayload({ turn: turn + 1 });
                  throw Object.assign(
                    new Error(payload.error ?? "Target call failed"),
                    { targetPayload: payload },
                  );
                }

                checkCancelled();

                // 2. Judge evaluates
                const judgment = await withSimulationSpan(
                  "orq.simulation.judge_evaluation",
                  undefined,
                  async () =>
                    external(() =>
                      judge.evaluate(
                        messages.map((m) => ({ ...m })),
                        { signal },
                      ),
                    ),
                );

                turnMetricsList.push(
                  buildTurnMetrics(
                    turn + 1,
                    judgment,
                    usageBefore,
                    detailedBefore,
                  ),
                );
                checkCancelled();
                lastJudgment = judgment;
                tracker.observe(judgment.criteria_verdicts);
                judge.markSettled?.(tracker.settledIds);

                try {
                  await external(() =>
                    this.config.hooks?.onTurnComplete?.(
                      params.datapoint?.id ?? "",
                      turnMetricsList[
                        turnMetricsList.length - 1
                      ] as TurnMetrics,
                    ),
                  );
                } catch (error) {
                  console.warn("onTurnComplete hook failed", error);
                }
                checkCancelled();

                setSpanAttrs(turnSpan, {
                  "orq.simulation.goal_achieved": judgment.goal_achieved,
                  "orq.simulation.goal_completion_score":
                    judgment.goal_completion_score,
                  "orq.simulation.should_terminate": judgment.should_terminate,
                });
              },
            );

            // Check if judge terminated after the turn span completes
            if (lastJudgment?.should_terminate) {
              const finalUsage = getTotalUsage();
              recordTokenUsage(runSpan, {
                promptTokens: finalUsage.prompt_tokens,
                completionTokens: finalUsage.completion_tokens,
                totalTokens: finalUsage.total_tokens,
              });
              setSpanAttrs(runSpan, {
                "orq.simulation.terminated_by": "judge",
                "orq.simulation.goal_achieved": lastJudgment.goal_achieved,
                "orq.simulation.turn_count": turn + 1,
              });

              const rulesBroken = tracker.resolve(lastJudgment.rules_broken);

              return {
                messages,
                terminated_by: "judge",
                reason: lastJudgment.reason,
                goal_achieved: lastJudgment.goal_achieved,
                goal_completion_score: lastJudgment.goal_completion_score,
                rules_broken: rulesBroken,
                turn_count: turn + 1,
                turn_metrics: turnMetricsList,
                token_usage: finalUsage,
                criteria_results: buildCriteriaResults(scenario, rulesBroken),
                criteria_verified: tracker.verified,
                metadata: {
                  ...simulationMetadata(persona, scenario),
                  criteria_meta: buildCriteriaMeta(
                    scenario,
                    rulesBroken,
                    tracker.hasAudit ? tracker.auditedIds : null,
                    tracker.hasAudit ? tracker.evidence : null,
                  ),
                },
              };
            }
          }

          // Max turns reached
          const finalUsage = getTotalUsage();
          recordTokenUsage(runSpan, {
            promptTokens: finalUsage.prompt_tokens,
            completionTokens: finalUsage.completion_tokens,
            totalTokens: finalUsage.total_tokens,
          });
          setSpanAttrs(runSpan, {
            "orq.simulation.terminated_by": "max_turns",
            "orq.simulation.goal_achieved":
              lastJudgment?.goal_achieved ?? false,
            "orq.simulation.turn_count": maxTurns,
          });

          return maxTurnsResult(
            maxTurns,
            messages,
            turnMetricsList,
            finalUsage,
            tracker,
            persona,
            scenario,
            lastJudgment,
          );
        },
      );
      result.usage = detailedUsage;
      result.response_traces = responseTraces;
      result.token_usage_known = usageKnown;
      if (targetModel) result.metadata.target_model = targetModel;
      result.metadata.datapoint_id = params.datapoint?.id;
      await external(() => this.config.hooks?.onDatapointComplete?.(result));
      return result;
    } catch (e) {
      if ([401, 403].includes(extractStatusCode(e) ?? 0))
        this.config.onFatalError?.(e);
      if (params.datapoint) {
        try {
          await external(() =>
            this.config.hooks?.onDatapointError?.(
              params.datapoint as Datapoint,
              e,
            ),
          );
        } catch (hookError) {
          console.warn("onDatapointError hook failed", hookError);
        }
      }
      console.error("SimulationRunner.run() failed:", e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      let usage: TokenUsage;
      try {
        usage = getTotalUsage ? getTotalUsage() : { ...ZERO_USAGE };
      } catch (usageErr) {
        console.warn("Failed to collect token usage:", usageErr);
        usage = { ...ZERO_USAGE };
      }
      const result = errorResult(errorMsg, persona, scenario);
      result.usage = detailedUsage;
      result.response_traces = responseTraces;
      result.token_usage_known = usageKnown;
      if (targetModel) result.metadata.target_model = targetModel;
      result.metadata.datapoint_id = params.datapoint?.id;
      const targetPayload =
        e && typeof e === "object" && "targetPayload" in e
          ? (e.targetPayload as { errorType?: unknown })
          : null;
      if (targetPayload) {
        Object.assign(result.metadata, targetPayload);
        if (targetPayload.errorType === "timeout")
          result.terminated_by = "timeout";
      }
      result.messages = messages;
      result.turn_count = messages.filter((m) => m.role === "assistant").length;
      result.turn_metrics = turnMetricsList;
      result.token_usage = usage;
      // A must_happen that has not occurred yet might still have occurred later,
      // so an aborted run only reports what is certain and marks the rest as not
      // audited.
      result.rules_broken = tracker.confirmedBrokenIds;
      result.criteria_verified = tracker.verified;
      const audited = tracker.auditedIds;
      for (const id of tracker.unconfirmedIds) {
        audited.delete(id);
      }
      if (targetPayload)
        result.criteria_results = buildCriteriaResults(
          scenario,
          result.rules_broken,
        );
      result.metadata.criteria_meta = targetPayload
        ? buildCriteriaMeta(
            scenario,
            result.rules_broken,
            audited,
            tracker.evidence,
          )
        : null;
      return result;
    } finally {
      if (target && target !== this.targetAgent) {
        const closing = closeTarget(target);
        pendingExternal.push(closing);
        try {
          await untilAborted(closing, signal);
        } catch (error) {
          if (!signal?.aborted) console.warn("Target cleanup failed", error);
        }
      }
      // A cancelled call can still mutate its agent after the row has returned.
      void reservation.ready
        .then(() => Promise.allSettled(pendingExternal))
        .then(reservation.release);
    }
  }

  /** Run simulations for multiple datapoints concurrently. */
  async runBatch(params: RunBatchParams): Promise<SimulationResult[]> {
    const { datapoints, maxTurns } = params;
    const timeoutMs = params.timeoutPerSimulation ?? 300_000;
    const maxConcurrency = params.maxConcurrency ?? 10;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)
      throw new RangeError("maxConcurrency must be >= 1");

    let active = 0;
    const queue: Array<() => void> = [];

    const acquireSemaphore = (): Promise<void> => {
      if (active < maxConcurrency) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    };

    const releaseSemaphore = (): void => {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    };

    const runSingle = async (
      datapoint: Datapoint,
    ): Promise<SimulationResult> => {
      await acquireSemaphore();
      try {
        return await this.runWithTimeout(datapoint, maxTurns, timeoutMs);
      } finally {
        releaseSemaphore();
      }
    };

    const settled = await Promise.allSettled(
      datapoints.map((dp) => runSingle(dp)),
    );

    return settled.map((result, i) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      const errorMsg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      const reason = `${result.reason?.constructor?.name ?? "Error"}: ${errorMsg}`;
      return errorResult(
        reason,
        datapoints[i]?.persona,
        datapoints[i]?.scenario,
      );
    });
  }

  /** Close and cleanup shared HTTP client. */
  async close(): Promise<void> {
    if (this.sharedClient) {
      // The OpenAI SDK doesn't expose a public close(). Setting the reference
      // to null allows GC to eventually release the connection pool.
      this.sharedClient = null;
    }
  }

  // ---- private helpers ----

  private async getTargetResponse(
    messages: ChatMessage[],
    conversation: object,
    signal: AbortSignal | undefined,
    target: TargetAgent | AgentTarget | undefined,
    onResponse: (response: AgentResponse) => void,
  ): Promise<TargetCallResult> {
    const call = async (callSignal?: AbortSignal): Promise<TargetCallResult> =>
      inConversation(conversation, async () => {
        const result = await callTargetWithRetry(
          {
            managesOwnTimeout: target?.managesOwnTimeout,
            timeoutMs:
              target && "timeoutMs" in target
                ? (target.timeoutMs as number)
                : undefined,
            respond: async (rows, options) => {
              const requestSignal =
                callSignal && options?.signal
                  ? AbortSignal.any([callSignal, options.signal])
                  : (callSignal ?? options?.signal);
              requestSignal?.throwIfAborted();
              if (target)
                return (target as TargetAgent).respond(
                  rows as unknown as ChatMessage[],
                  { signal: requestSignal },
                );
              if (!this.targetCallback)
                throw new Error("No target agent or callback configured");
              return this.targetCallback(rows as unknown as ChatMessage[]);
            },
          },
          messages.map((message) => MessageSchema.parse(message)),
          {
            targetAgentTimeoutMs: this.config.targetAgentTimeoutMs ?? 240_000,
            maxTargetRetries: this.config.maxTargetRetries ?? 2,
            signal: callSignal,
            mapError: (error) => {
              if ([401, 403].includes(extractStatusCode(error) ?? 0))
                this.config.onFatalError?.(error);
              return {
                code: "target_error",
                message: error instanceof Error ? error.message : String(error),
              };
            },
            onAttemptResponse: (_context, response) => onResponse(response),
          },
        );
        return result;
      });
    return call(signal);
  }

  /**
   * Run one datapoint with a timeout. Never throws. `elapsedMs` is time this row
   * already spent, which counts against the limit.
   */
  async runWithTimeout(
    datapoint: Datapoint,
    maxTurns: number | undefined,
    timeoutMs: number,
    elapsedMs = 0,
  ): Promise<SimulationResult> {
    if (timeoutMs <= 0) {
      return this.run({ datapoint, maxTurns });
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, timeoutMs - elapsedMs),
    );

    return new Promise<SimulationResult>((resolve) => {
      // run() never throws : it catches all errors internally and returns
      // an error SimulationResult. The .catch() is a safety net in case
      // that contract is ever broken.
      this.run({ datapoint, maxTurns, signal: controller.signal }).then(
        (result) => {
          clearTimeout(timer);
          if (controller.signal.aborted) {
            resolve(timedOutResult(result, timeoutMs));
          } else {
            resolve(result);
          }
        },
        (err) => {
          clearTimeout(timer);
          const reason = err instanceof Error ? err.message : String(err);
          resolve(errorResult(reason, datapoint.persona, datapoint.scenario));
        },
      );
    });
  }
}
