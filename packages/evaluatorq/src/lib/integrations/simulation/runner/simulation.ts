/**
 * Simulation runner for orchestrating agent conversations.
 *
 * Manages the simulation loop between user simulator, target agent,
 * and judge agent.
 */

import OpenAI from "openai";

import { JudgeAgent } from "../agents/judge.js";
import { UserSimulatorAgent } from "../agents/user-simulator.js";
import {
  recordLLMInput,
  recordTokenUsage,
  setSpanAttrs,
  withSimulationSpan,
} from "../tracing.js";
import type {
  ChatMessage,
  Datapoint,
  Judgment,
  Message,
  Persona,
  Scenario,
  SimulationResult,
  TokenUsage,
  TurnMetrics,
} from "../types.js";
import { buildDatapointSystemPrompt } from "../utils/prompt-builders.js";

// ---------------------------------------------------------------------------
// Protocols / interfaces
// ---------------------------------------------------------------------------

/** Protocol for target agents being tested. */
export interface TargetAgent {
  respond(messages: ChatMessage[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SimulationRunnerConfig {
  targetAgent?: TargetAgent;
  targetCallback?: (messages: ChatMessage[]) => string | Promise<string>;
  model?: string;
  maxTurns?: number;
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

function errorResult(
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
    token_usage: { ...ZERO_USAGE },
    metadata: {
      persona: persona?.name ?? "unknown",
      scenario: scenario?.name ?? "unknown",
      error: reason,
    },
  };
}

function maxTurnsResult(
  maxTurns: number,
  messages: Message[],
  turnMetrics: TurnMetrics[],
  tokenUsage: TokenUsage,
  persona?: Persona,
  scenario?: Scenario,
  lastJudgment?: Judgment,
): SimulationResult {
  return {
    messages,
    terminated_by: "max_turns",
    reason: `Maximum turns (${maxTurns}) reached`,
    goal_achieved: lastJudgment?.goal_achieved ?? false,
    goal_completion_score: lastJudgment?.goal_completion_score ?? 0,
    rules_broken: lastJudgment?.rules_broken ?? [],
    turn_count: maxTurns,
    turn_metrics: turnMetrics,
    token_usage: tokenUsage,
    metadata: { persona: persona?.name, scenario: scenario?.name },
  };
}

// ---------------------------------------------------------------------------
// SimulationRunner
// ---------------------------------------------------------------------------

export class SimulationRunner {
  private readonly targetAgent?: TargetAgent;
  private readonly targetCallback?: (
    messages: ChatMessage[],
  ) => string | Promise<string>;
  private readonly model: string;
  private readonly maxTurns: number;
  private sharedClient: OpenAI | null = null;

  constructor(config: SimulationRunnerConfig) {
    if (!config.targetAgent && !config.targetCallback) {
      throw new Error("Must provide either targetAgent or targetCallback");
    }
    const maxTurns = config.maxTurns ?? 10;
    if (maxTurns < 1) {
      throw new Error(`maxTurns must be >= 1, got ${maxTurns}`);
    }
    const model = config.model ?? "azure/gpt-4o-mini";
    if (!model.trim()) {
      throw new Error("model must be a non-empty string");
    }

    this.targetAgent = config.targetAgent;
    this.targetCallback = config.targetCallback;
    this.model = model;
    this.maxTurns = maxTurns;
  }

  private getSharedClient(): OpenAI {
    if (!this.sharedClient) {
      const apiKey = process.env.ORQ_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ORQ_API_KEY environment variable is not set. Set it or pass a pre-configured client.",
        );
      }
      this.sharedClient = new OpenAI({
        apiKey,
        baseURL: process.env.ROUTER_BASE_URL ?? "https://api.orq.ai/v2/router",
      });
    }
    return this.sharedClient;
  }

  /** Run a single simulation. Never throws -- returns error SimulationResult on failure. */
  async run(params: RunParams): Promise<SimulationResult> {
    let persona: Persona | undefined = params.persona;
    let scenario: Scenario | undefined = params.scenario;
    let firstMessage: string | undefined = params.firstMessage;
    let storedSystemPrompt: string | undefined;
    const signal = params.signal;

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

    const messages: Message[] = [];
    const turnMetricsList: TurnMetrics[] = [];

    // Declare usage helper references — initialized inside try after agents are created
    let getTotalUsage: (() => TokenUsage) | undefined;

    try {
      return await withSimulationSpan(
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

          const client = this.getSharedClient();

          // Always create fresh agents per simulation (no shared state between concurrent runs)
          const userSimulator = new UserSimulatorAgent({
            model: this.model,
            client,
            systemPrompt: systemPrompt,
          });

          const judge = new JudgeAgent({
            model: this.model,
            client,
            goal: scenario?.goal,
            criteria: scenario?.criteria ?? [],
            groundTruth: scenario?.ground_truth ?? "",
          });

          getTotalUsage = (): TokenUsage => {
            const usage = userSimulator.getUsage();
            const judgeUsage = judge.getUsage();
            usage.prompt_tokens += judgeUsage.prompt_tokens;
            usage.completion_tokens += judgeUsage.completion_tokens;
            usage.total_tokens += judgeUsage.total_tokens;
            return usage;
          };

          const buildTurnMetrics = (
            turnNum: number,
            judgment: Judgment,
            usageBefore: TokenUsage,
          ): TurnMetrics => {
            const usageAfter = (getTotalUsage as () => TokenUsage)();
            return {
              turn_number: turnNum,
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
                async () => userSimulator.generateFirstMessage(),
              );
          messages.push({ role: "user", content: firstMsg });

          let lastJudgment: Judgment | undefined;

          for (let turn = 0; turn < maxTurns; turn++) {
            checkCancelled();
            const usageBefore = getTotalUsage();

            await withSimulationSpan(
              "orq.simulation.turn",
              {
                "orq.simulation.turn": turn + 1,
                "orq.simulation.max_turns": maxTurns,
              },
              async (turnSpan) => {
                // 1. Target agent responds
                const targetMessages = messages.map((m) => ({
                  role: m.role,
                  content: m.content,
                }));
                const agentResponse = await withSimulationSpan(
                  "orq.simulation.target_call",
                  undefined,
                  async (targetSpan) => {
                    recordLLMInput(targetSpan, targetMessages);
                    const response =
                      await this.getTargetResponse(targetMessages);
                    setSpanAttrs(targetSpan, {
                      output: response,
                    });
                    return response;
                  },
                );
                messages.push({ role: "assistant", content: agentResponse });

                checkCancelled();

                // 2. Judge evaluates
                const judgment = await withSimulationSpan(
                  "orq.simulation.judge_evaluation",
                  undefined,
                  async () =>
                    judge.evaluate(
                      messages.map((m) => ({
                        role: m.role,
                        content: m.content,
                      })),
                      { signal },
                    ),
                );

                turnMetricsList.push(
                  buildTurnMetrics(turn + 1, judgment, usageBefore),
                );
                lastJudgment = judgment;

                setSpanAttrs(turnSpan, {
                  "orq.simulation.goal_achieved": judgment.goal_achieved,
                  "orq.simulation.goal_completion_score":
                    judgment.goal_completion_score,
                  "orq.simulation.should_terminate": judgment.should_terminate,
                });

                if (!judgment.should_terminate && turn < maxTurns - 1) {
                  // 3. User simulator continues
                  checkCancelled();
                  const userResponse = await withSimulationSpan(
                    "orq.simulation.user_simulator_call",
                    undefined,
                    async () =>
                      userSimulator.respondAsync(
                        messages.map((m) => ({
                          role: m.role,
                          content: m.content,
                        })),
                        { signal, llmPurpose: "user_simulator" },
                      ),
                  );
                  messages.push({ role: "user", content: userResponse });
                }
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

              return {
                messages,
                terminated_by: "judge",
                reason: lastJudgment.reason,
                goal_achieved: lastJudgment.goal_achieved,
                goal_completion_score: lastJudgment.goal_completion_score,
                rules_broken: lastJudgment.rules_broken,
                turn_count: turn + 1,
                turn_metrics: turnMetricsList,
                token_usage: finalUsage,
                criteria_results: this.buildCriteriaResults(
                  scenario as Scenario,
                  lastJudgment,
                ),
                metadata: {
                  persona: persona?.name,
                  scenario: scenario?.name,
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
            persona,
            scenario,
            lastJudgment,
          );
        },
      );
    } catch (e) {
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
      result.messages = messages;
      result.turn_count = messages.filter((m) => m.role === "assistant").length;
      result.turn_metrics = turnMetricsList;
      result.token_usage = usage;
      return result;
    }
  }

  /** Run simulations for multiple datapoints concurrently. */
  async runBatch(params: RunBatchParams): Promise<SimulationResult[]> {
    const { datapoints, maxTurns } = params;
    const timeoutMs = params.timeoutPerSimulation ?? 300_000;
    const maxConcurrency = params.maxConcurrency ?? 10;

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

  private async getTargetResponse(messages: ChatMessage[]): Promise<string> {
    if (this.targetAgent) {
      return this.targetAgent.respond(messages);
    }
    if (this.targetCallback) {
      return this.targetCallback(messages);
    }
    throw new Error("No target agent or callback configured");
  }

  /**
   * Build criteria_results map from the judge's final judgment.
   * Maps each criterion description to whether it was satisfied.
   */
  private buildCriteriaResults(
    scenario: Scenario,
    judgment: Judgment,
  ): Record<string, boolean> {
    const results: Record<string, boolean> = {};
    const criteria = scenario.criteria ?? [];
    const rulesBroken = new Set(judgment.rules_broken);

    for (const criterion of criteria) {
      // A criterion is satisfied if it's NOT listed in rules_broken.
      // This applies to both types: must_happen (it happened) and must_not_happen (it didn't happen).
      results[criterion.description] = !rulesBroken.has(criterion.description);
    }

    return results;
  }

  private async runWithTimeout(
    datapoint: Datapoint,
    maxTurns: number | undefined,
    timeoutMs: number,
  ): Promise<SimulationResult> {
    if (timeoutMs <= 0) {
      return this.run({ datapoint, maxTurns });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return new Promise<SimulationResult>((resolve) => {
      // run() never throws — it catches all errors internally and returns
      // an error SimulationResult. The .catch() is a safety net in case
      // that contract is ever broken.
      this.run({ datapoint, maxTurns, signal: controller.signal }).then(
        (result) => {
          clearTimeout(timer);
          if (controller.signal.aborted) {
            resolve({
              ...result,
              terminated_by: "timeout" as const,
              reason: `Simulation timed out after ${timeoutMs}ms`,
              metadata: {
                ...(result.metadata as Record<string, unknown>),
                timeout: timeoutMs,
              },
            });
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
