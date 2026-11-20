/**
 * Simulation runner for orchestrating agent conversations.
 *
 * Manages the simulation loop between user simulator, target agent,
 * and judge agent.
 */

import type OpenAI from "openai";

import { JudgeAgent } from "../agents/judge.js";
import { UserSimulatorAgent } from "../agents/user-simulator.js";
import { createRouterClient } from "../client.js";
import { inConversation } from "../conversation.js";
import {
  buildCriteriaMeta,
  buildCriteriaResults,
  CriteriaTracker,
} from "../criteria.js";
import { DEFAULT_SIMULATION_MODEL } from "../defaults.js";
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
    token_usage: { ...ZERO_USAGE },
    metadata: {
      persona: persona?.name ?? "unknown",
      scenario: scenario?.name ?? "unknown",
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
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "assistant", content: m.content };
    if (m.role === "assistant") return { role: "user", content: m.content };
    return { role: m.role, content: m.content };
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
      persona: persona?.name,
      scenario: scenario?.name,
      criteria_meta: buildCriteriaMeta(
        scenario,
        rulesBroken,
        tracker.verified ? tracker.auditedIds : null,
        tracker.verified ? tracker.evidence : null,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// SimulationRunner
// ---------------------------------------------------------------------------

export class SimulationRunner {
  private readonly targetAgent?: TargetAgent;
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
    if (maxTurns < 1) {
      throw new Error(`maxTurns must be >= 1, got ${maxTurns}`);
    }
    const model = config.model ?? DEFAULT_SIMULATION_MODEL;
    if (!model.trim()) {
      throw new Error("model must be a non-empty string");
    }

    this.targetAgent = config.targetAgent;
    this.targetCallback = config.targetCallback;
    this.model = model;
    this.maxTurns = maxTurns;
    this.injectedClient = config.client;
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
    const signal = params.signal;
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

    // Declare usage helper references — initialized inside try after agents are created
    let getTotalUsage: (() => TokenUsage) | undefined;

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
                async () =>
                  userSimulator.generateFirstMessage(undefined, signal),
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
                    const response = await this.getTargetResponse(
                      targetMessages,
                      conversation,
                      signal,
                    );
                    recordLLMOutput(targetSpan, response);
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
                tracker.observe(judgment.criteria_verdicts);
                judge.markSettled(tracker.settledIds);

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
                        invertRolesForSimulator(messages),
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
                  persona: persona?.name,
                  scenario: scenario?.name,
                  criteria_meta: buildCriteriaMeta(
                    scenario,
                    rulesBroken,
                    tracker.verified ? tracker.auditedIds : null,
                    tracker.verified ? tracker.evidence : null,
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
      // A must_happen that has not occurred yet might still have occurred later,
      // so an aborted run only reports what is certain and marks the rest as not
      // audited.
      result.rules_broken = tracker.confirmedBrokenIds;
      result.criteria_verified = tracker.verified;
      const audited = tracker.auditedIds;
      for (const id of tracker.unconfirmedIds) {
        audited.delete(id);
      }
      result.criteria_results = buildCriteriaResults(
        scenario,
        result.rules_broken,
      );
      result.metadata.criteria_meta = buildCriteriaMeta(
        scenario,
        result.rules_broken,
        audited,
        tracker.evidence,
      );
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

  private async getTargetResponse(
    messages: ChatMessage[],
    conversation: object,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const call = (): Promise<string> =>
      inConversation(conversation, async () => {
        if (this.targetAgent) {
          return this.targetAgent.respond(messages);
        }
        if (this.targetCallback) {
          return this.targetCallback(messages);
        }
        throw new Error("No target agent or callback configured");
      });
    if (!signal) {
      return call();
    }

    // A callback takes no signal and cannot be stopped, so stop waiting for it.
    // It may keep running after this returns.
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Simulation cancelled"));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([call(), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
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
      // run() never throws — it catches all errors internally and returns
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
