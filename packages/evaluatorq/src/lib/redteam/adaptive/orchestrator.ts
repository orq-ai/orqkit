import type { Span } from "@opentelemetry/api";
import type OpenAI from "openai";

import {
  isContentFilterError,
  regenerateOnContentFilter,
} from "../../common/content-filter.js";
import { ClassifyQuestionSchema, runJudge } from "../../common/judge.js";
import {
  type ChatCompletionLike,
  executeChatCompletion,
} from "../../common/llm-call.js";
import { coerceContentText } from "../../common/messages.js";
import {
  applyCacheBreakpoints,
  cachingApplies,
} from "../../common/prompt-cache.js";
import { pythonStrip, xmlEscape } from "../../common/sanitize.js";
import { usageFromException } from "../../common/structured-output.js";
import {
  callTargetWithRetry,
  defaultMapError,
  type TargetErrorPayload,
} from "../../common/target-call.js";
import { setSpanAttrs, truncateForSpan } from "../../common/tracing.js";
import {
  type AgentContext,
  AgentResponse,
  type AgentTarget,
  addUsage,
  LLMCallConfig,
  type LLMCallConfigInput,
  LLMCallConfigSchema,
  type Message,
  MessageSchema,
  textOutputItem,
  type Usage,
  UsageSchema,
} from "../../contracts.js";
import type { Backend } from "../backends/base.js";
import { attackerModelFor, LLMConfig, PIPELINE_CONFIG } from "../config.js";
import { DeliveryMethod } from "../contracts.js";
import { OrchestratorResult } from "../result.js";
import type { AttackStrategy } from "../strategy.js";
import {
  ensureTargetCanBacktrack,
  replaySeedContext,
  type TraceStart,
} from "../traces.js";
import { withRedteamLlmSpan, withRedteamSpan } from "../tracing.js";
import { Turn, turnsToMessages } from "../turn.js";
import {
  accumulateTargetUsage,
  buildAdversarialSystemPrompt,
  mergeAttackUsage,
  parseObjectiveMarker,
  refusalJudgeModel,
} from "./orchestrator-helpers.js";
import { type AttackProgress, getActiveProgress } from "./progress.js";
import {
  ADVERSARIAL_ANALYSIS_PROMPT,
  ADVERSARIAL_BACKTRACK_PROMPT,
  ADVERSARIAL_INITIAL_USER_PROMPT,
  REFUSAL_CLASSIFY_INSTRUCTIONS,
  REFUSAL_CLASSIFY_THRESHOLD,
  REFUSAL_JUDGE_PROMPT,
  REFUSAL_JUDGE_SYSTEM_PROMPT,
} from "./prompts.js";
import {
  formatPlanForPrompt,
  ToolChainingPlanner,
  ToolChainingVerifier,
} from "./tool-chaining.js";

interface AttackerTurn {
  usageDelta: Usage;
  consecutiveTimeouts: number;
  failure?: TargetErrorPayload;
  retry?: boolean;
  truncated?: boolean;
  usage?: Usage | null;
  prompt?: string;
  attacker?: AgentResponse;
}
export interface MultiTurnOrchestratorOptions {
  model?: string | null;
  backend?: Backend | null;
  attackerInstructions?: string | null;
  verbosity?: number;
  llmKwargs?: Record<string, unknown> | null;
  pipelineConfig?: LLMConfig | null;
}
export interface RunAttackOptions {
  seedMessages?: Message[] | null;
  traceStartFrom?: TraceStart | null;
  signal?: AbortSignal;
}
function failure(
  error: string,
  type: string,
  code: string,
  details: Record<string, unknown>,
  turn: number | null,
): TargetErrorPayload {
  return {
    error,
    errorType: type,
    errorStage: "adversarial_generation",
    errorCode: code,
    errorDetails: details,
    errorTurn: turn,
  };
}
function canceled(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error as { name?: unknown } | null)?.name === "AbortError"
  );
}
async function startProgress(
  progress: AttackProgress | null,
  strategy: AttackStrategy,
  maxTurns: number,
): Promise<number | null> {
  if (!progress) return null;
  const label = `${strategy.category}:${strategy.name}`,
    characters = Array.from(label);
  try {
    return await progress.startAttack(
      characters.length > 52 ? `${characters.slice(0, 51).join("")}…` : label,
      maxTurns,
    );
  } catch (error) {
    if (canceled(error)) throw error;
    console.warn("Failed to start attack progress", error);
    return null;
  }
}
export class MultiTurnOrchestrator {
  readonly model: string;
  readonly config: LLMConfig;
  constructor(
    readonly client: OpenAI,
    readonly options: MultiTurnOrchestratorOptions = {},
  ) {
    this.model = attackerModelFor(options.model, options.pipelineConfig);
    const cfg = options.pipelineConfig ?? PIPELINE_CONFIG;
    this.config =
      options.llmKwargs && Object.keys(options.llmKwargs).length
        ? new LLMConfig({
            ...cfg,
            attacker: new LLMCallConfig({
              ...cfg.attacker.setValues(
                ...(Object.keys(
                  LLMCallConfigSchema.shape,
                ) as (keyof LLMCallConfigInput)[]),
              ),
              extraKwargs: {
                ...cfg.attacker.extraKwargs,
                ...options.llmKwargs,
              },
            }),
          })
        : cfg;
  }
  private mapError = (error: unknown) =>
    this.options.backend?.mapError(error) ?? defaultMapError(error);
  async generateSinglePrompt(
    strategy: AttackStrategy,
    objective: string,
    context: AgentContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<[string, Usage | null, string]> {
    const system = buildAdversarialSystemPrompt(
      objective,
      strategy,
      context,
      1,
      { attackerInstructions: this.options.attackerInstructions },
    );
    const messages = [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Generate a single attack prompt to achieve the objective in one message.",
      },
    ];
    return withRedteamSpan(
      "orq.redteam.adversarial_generation",
      { "orq.redteam.strategy_name": strategy.name },
      async () =>
        withRedteamLlmSpan(
          {
            model: this.model,
            temperature: this.config.attacker.temperature,
            maxTokens: this.config.attacker.maxTokens,
            inputMessages: messages,
            attributes: {
              "orq.redteam.llm_purpose": "adversarial",
              "orq.redteam.strategy_name": strategy.name,
            },
          },
          async (span) => {
            const called = await this.complete(messages, span, options.signal);
            const choice = called.response.choices[0];
            if (!choice)
              throw new Error("Adversarial response contained no choices");
            return [
              parseObjectiveMarker(
                coerceContentText(choice.message.content),
              )[2],
              called.usage,
              system,
            ];
          },
        ),
    );
  }
  private complete(
    messages: Record<string, unknown>[],
    span: Span | undefined,
    signal?: AbortSignal,
  ) {
    const cfg = this.config;
    return executeChatCompletion({
      client: this.client,
      model: this.model,
      messages,
      span,
      timeoutMs: cfg.attacker.timeoutMs,
      temperature: cfg.attacker.temperature,
      maxCompletionTokens: cfg.attacker.maxTokens,
      reasoningEffort: cfg.attacker.reasoningEffort,
      extraBody: cfg.retryExtraBody(this.client),
      extraKwargs: cfg.attacker.extraKwargs,
      signal,
    });
  }
  private async planToolChain(
    strategy: AttackStrategy,
    objective: string,
    context: AgentContext,
    maxTurns: number,
    signal?: AbortSignal,
  ): Promise<[string | null, Usage | null]> {
    if (!strategy.decomposeToolChain || !context.tools.length)
      return [null, null];
    let usage: Usage | null = null;
    try {
      return await withRedteamSpan(
        "orq.redteam.tool_chain_decomposition",
        {
          "orq.redteam.strategy_name": strategy.name,
          "orq.span_type": "span.generic",
        },
        async () => {
          const names = context.tools.map((tool) => tool.name);
          const decomposition = await new ToolChainingPlanner(
            this.client,
            this.model,
            this.config,
          ).decompose(
            objective,
            context.displayName || context.key,
            context.description || "An AI assistant",
            names,
            { signal },
          );
          usage = decomposition.tokenUsage;
          let [valid] = new ToolChainingVerifier(names).verifyAll(
            decomposition.steps,
          );
          if (!valid.length) {
            console.warn(
              `No tool-chain steps survived verification for ${strategy.name}`,
            );
            return [null, usage];
          }
          if (valid.length > maxTurns) valid = valid.slice(0, maxTurns);
          return [formatPlanForPrompt(valid), usage];
        },
      );
    } catch (error) {
      if (canceled(error, signal)) throw error;
      console.warn(
        `Tool-chain decomposition failed for ${strategy.name}; continuing without a plan`,
        error,
      );
      return [null, usageFromException(error) ?? usage];
    }
  }
  private async attackerTurn(
    turn: number,
    maxTurns: number,
    strategy: AttackStrategy,
    messages: Record<string, unknown>[],
    consecutive: number,
    span: Span | undefined,
    signal?: AbortSignal,
  ): Promise<AttackerTurn> {
    let delta = UsageSchema.parse({}),
      usage: Usage | null = null,
      prompt = "",
      response: ChatCompletionLike;
    const cfg = this.config,
      maxAttempts = Math.max(1, cfg.maxContentFilterRetries + 1);
    const sent = cachingApplies(this.client, this.model)
      ? applyCacheBreakpoints(messages, { volatileTail: 0 })
      : messages;
    try {
      response = await regenerateOnContentFilter(
        async (attempt) =>
          withRedteamSpan(
            "orq.redteam.adversarial_generation",
            {
              "orq.redteam.turn": turn + 1,
              "orq.redteam.strategy_name": strategy.name,
            },
            async () =>
              withRedteamLlmSpan(
                {
                  model: this.model,
                  temperature: cfg.attacker.temperature,
                  maxTokens: cfg.attacker.maxTokens,
                  inputMessages: sent,
                  attributes: {
                    "orq.redteam.llm_purpose": "adversarial",
                    "orq.redteam.turn": turn + 1,
                    "orq.redteam.strategy_name": strategy.name,
                  },
                },
                async (llmSpan) => {
                  if (attempt > 0)
                    setSpanAttrs(llmSpan, {
                      "orq.redteam.adversarial_retry": attempt,
                    });
                  const called = await this.complete(sent, llmSpan, signal);
                  usage = called.usage;
                  delta = addUsage(
                    delta,
                    usage ?? UsageSchema.parse({ calls: 1 }),
                  );
                  const choice = called.response.choices[0];
                  if (!choice)
                    throw new Error(
                      "Adversarial response contained no choices",
                    );
                  prompt = coerceContentText(choice.message.content);
                  return called.response;
                },
              ),
          ),
        {
          maxAttempts,
          label: `Attack model for ${strategy.name} on turn ${turn + 1}`,
        },
      );
    } catch (error) {
      if (canceled(error, signal)) throw error;
      if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
        consecutive++;
        setSpanAttrs(span, {
          "orq.redteam.error_type": "llm_error",
          "orq.redteam.finish_reason": "adversarial_timeout",
        });
        if (consecutive >= cfg.maxConsecutiveAdversarialTimeouts)
          return {
            usageDelta: delta,
            consecutiveTimeouts: consecutive,
            failure: failure(
              `Adversarial LLM timed out ${consecutive} consecutive turns after ${(cfg.attacker.timeoutMs / 1000).toFixed(0)}s each`,
              "llm_error",
              "adversarial.timeout",
              {
                timeoutMs: cfg.attacker.timeoutMs,
                consecutiveTimeouts: consecutive,
              },
              turn + 1,
            ),
          };
        return {
          usageDelta: delta,
          consecutiveTimeouts: consecutive,
          retry: true,
        };
      }
      const filtered = isContentFilterError(error),
        type = filtered ? "content_filter" : "llm_error",
        message = error instanceof Error ? error.message : String(error);
      setSpanAttrs(span, {
        "orq.redteam.error_type": type,
        "orq.redteam.finish_reason": "adversarial_error",
      });
      return {
        usageDelta: delta,
        consecutiveTimeouts: consecutive,
        failure: failure(
          `Adversarial LLM exception: ${message}`,
          type,
          filtered ? "adversarial.content_filter" : "adversarial.llm_exception",
          {
            exceptionType:
              (error as { constructor?: { name?: string } } | null)?.constructor
                ?.name ?? typeof error,
            rawMessage: message,
          },
          turn + 1,
        ),
      };
    }
    const choice = response.choices[0],
      reason = choice?.finish_reason ?? null,
      truncated = reason === "length";
    if (!pythonStrip(prompt)) {
      const type =
        reason === "content_filter"
          ? "content_filter"
          : reason === "length"
            ? "max_tokens"
            : "empty_response";
      setSpanAttrs(span, {
        "orq.redteam.error_type": type,
        "orq.redteam.finish_reason":
          reason === "content_filter" ? "content_filter" : "empty_prompt",
      });
      return {
        usageDelta: delta,
        consecutiveTimeouts: 0,
        truncated,
        failure: failure(
          `Empty adversarial prompt: finish_reason=${reason ?? "None"}, model=${response.model ?? this.model}, turn=${turn + 1}/${maxTurns}`,
          type,
          `adversarial.${type}`,
          {
            finishReason: reason,
            model: response.model ?? this.model,
            turn: turn + 1,
          },
          turn + 1,
        ),
      };
    }
    if (reason === "content_filter") {
      setSpanAttrs(span, {
        "orq.redteam.error_type": "content_filter",
        "orq.redteam.finish_reason": "content_filter",
      });
      return {
        usageDelta: delta,
        consecutiveTimeouts: 0,
        truncated,
        failure: failure(
          `Attack model content_filter after ${maxAttempts} attempt(s): finish_reason=${reason}, turn=${turn + 1}/${maxTurns}`,
          "content_filter",
          "adversarial.content_filter",
          { finishReason: reason, turn: turn + 1, attempts: maxAttempts },
          turn + 1,
        ),
      };
    }
    return {
      usageDelta: delta,
      consecutiveTimeouts: 0,
      truncated,
      usage,
      prompt,
      attacker: new AgentResponse({
        text: prompt,
        usage,
        finishReason: reason,
      }),
    };
  }
  private async isRefusal(
    prompt: string,
    response: AgentResponse,
    signal?: AbortSignal,
  ): Promise<[boolean | null, Usage | null]> {
    const text = pythonStrip(response.text);
    if (response.refusal && text === pythonStrip(response.refusal))
      return [true, null];
    if (!text) return [false, null];
    signal?.throwIfAborted();
    const [model, useClassify] = await refusalJudgeModel(this.client),
      attacker = this.config.attacker;
    const outcome = await runJudge({
      client: this.client,
      model,
      cfg: new LLMCallConfig({
        model,
        timeoutMs: attacker.timeoutMs,
        retryCount: attacker.retryCount,
      }),
      promptTemplate: REFUSAL_JUDGE_PROMPT,
      replacements: {
        user_message: xmlEscape(prompt),
        agent_reply: xmlEscape(response.text),
      },
      systemPrompt: REFUSAL_JUDGE_SYSTEM_PROMPT,
      spanAttributes: {
        "orq.redteam.llm_purpose": "refusal_judge",
        "orq.llm.purpose": "refusal_judge",
      },
      temperature: null,
      classify: useClassify
        ? ClassifyQuestionSchema.parse({
            kind: "noul",
            instructions: REFUSAL_CLASSIFY_INSTRUCTIONS,
            state: { user_message: prompt, agent_reply: response.text },
            noulThreshold: REFUSAL_CLASSIFY_THRESHOLD,
          })
        : null,
    });
    signal?.throwIfAborted();
    const verdict =
      outcome.payload && !outcome.payload.abstain
        ? outcome.payload.value
        : null;
    if (outcome.errorKind !== null || typeof verdict !== "boolean") {
      console.warn(
        "Refusal judge gave no usable verdict; keeping the turn",
        outcome.errorMessage ?? verdict,
      );
      return [null, outcome.tokenUsage];
    }
    return [verdict, outcome.tokenUsage];
  }
  async runAttack(
    target: AgentTarget,
    strategy: AttackStrategy,
    objective: string,
    context: AgentContext,
    maxTurns: number,
    options: RunAttackOptions = {},
  ): Promise<OrchestratorResult> {
    options.signal?.throwIfAborted();
    const started = Date.now(),
      cfg = this.config;
    const maxBacktracks =
      cfg.maxBacktracks &&
      strategy.deliveryMethods.includes(DeliveryMethod.CRESCENDO)
        ? cfg.maxBacktracks
        : 0;
    if (maxBacktracks) ensureTargetCanBacktrack(target);
    let seedContext: Message[] | null = null,
      bootstrapUsage: Usage | null = null;
    if (options.seedMessages != null) {
      const [seed, usage, error] = await replaySeedContext(
        target,
        options.seedMessages,
        options.traceStartFrom ?? "first_user",
        {
          targetAgentTimeoutMs: cfg.targetAgentTimeoutMs,
          maxTargetRetries: cfg.maxTargetRetries,
          mapError: this.mapError,
          signal: options.signal,
        },
      );
      seedContext = seed;
      bootstrapUsage = usage;
      if (error)
        return new OrchestratorResult({
          maxTurns,
          seedContext: seed,
          tokenUsageBootstrap: usage,
          tokenUsage: mergeAttackUsage(usage),
          ...error,
        });
    }
    const [plan, planUsage] = await this.planToolChain(
      strategy,
      objective,
      context,
      maxTurns,
      options.signal,
    );
    let adversarialUsage = addUsage(UsageSchema.parse({}), planUsage),
      targetUsage = UsageSchema.parse({});
    const system = buildAdversarialSystemPrompt(
      objective,
      strategy,
      context,
      maxTurns,
      {
        attackerInstructions: this.options.attackerInstructions,
        toolChainPlan: plan,
        seedContext,
      },
    );
    const messages: Record<string, unknown>[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: ADVERSARIAL_INITIAL_USER_PROMPT.replaceAll(
          "{max_turns}",
          String(maxTurns),
        ),
      },
    ];
    const turns: Turn[] = [],
      backtracked: Turn[] = [];
    let refusalJudgeFailures = 0,
      objectiveAchieved = false,
      objectiveRationale: string | null = null,
      error: TargetErrorPayload | null = null,
      consecutive = 0;
    let truncatedTurns: number[] = [];
    const progress = getActiveProgress(),
      taskId = await startProgress(progress, strategy, maxTurns);
    try {
      for (
        let attempt = 0;
        attempt - backtracked.length < maxTurns;
        attempt++
      ) {
        options.signal?.throwIfAborted();
        const turn = attempt - backtracked.length;
        const action = await withRedteamSpan(
          "orq.redteam.attack_turn",
          {
            "orq.redteam.turn": turn + 1,
            "orq.redteam.max_turns": maxTurns,
            "orq.redteam.strategy_name": strategy.name,
            "orq.redteam.category": strategy.category,
            "orq.redteam.vulnerability": strategy.vulnerability ?? "",
          },
          async (span) => {
            await progress?.updateAttack(taskId, turn);
            const gen = await this.attackerTurn(
              turn,
              maxTurns,
              strategy,
              messages,
              consecutive,
              span,
              options.signal,
            );
            adversarialUsage = addUsage(adversarialUsage, gen.usageDelta);
            consecutive = gen.consecutiveTimeouts;
            if (gen.truncated) truncatedTurns.push(turn + 1);
            if (gen.failure) {
              error = gen.failure;
              return "break";
            }
            if (gen.retry) return "continue";
            let prompt = gen.prompt ?? "",
              attacker = gen.attacker ?? new AgentResponse();
            const [present, rationale, payload] = parseObjectiveMarker(prompt);
            if (present) {
              if (turns.length) {
                objectiveAchieved = true;
                objectiveRationale = rationale;
              } else
                console.warn(
                  "Ignoring objective-achieved self-report before any completed target turn",
                );
              prompt = payload;
              attacker = new AgentResponse({
                ...attacker,
                output: [textOutputItem(prompt)],
              });
              if (!prompt) {
                if (progress && taskId !== null)
                  await progress.updateAttack(taskId, turn + 1);
                setSpanAttrs(span, {
                  "orq.redteam.adversarial_tokens": gen.usage?.totalTokens ?? 0,
                  "orq.redteam.finish_reason": objectiveAchieved
                    ? "objective_achieved"
                    : "no_usable_prompt",
                  "orq.redteam.objective_rationale": Array.from(
                    objectiveRationale ?? "",
                  )
                    .slice(0, 500)
                    .join(""),
                });
                return "break";
              }
            }
            const transcript = [
              ...(seedContext ?? []),
              ...turnsToMessages(turns, { skipErrors: true }),
              MessageSchema.parse({ role: "user", content: prompt }),
            ];
            const result = await callTargetWithRetry(target, transcript, {
              targetAgentTimeoutMs: cfg.targetAgentTimeoutMs,
              maxTargetRetries: cfg.maxTargetRetries,
              mapError: this.mapError,
              signal: options.signal,
              onAttempt: (index, run) =>
                withRedteamSpan(
                  "orq.redteam.target_call",
                  {
                    "orq.redteam.turn": turn + 1,
                    "orq.redteam.strategy_name": strategy.name,
                    "orq.redteam.target_attempt": index + 1,
                    input: truncateForSpan(prompt),
                    "orq.redteam.input": truncateForSpan(prompt),
                  },
                  async (targetSpan) => run(targetSpan),
                ),
              onAttemptResponse: (targetSpan, response) =>
                setSpanAttrs(targetSpan as Span | undefined, {
                  output: truncateForSpan(response.text),
                  "orq.redteam.output": truncateForSpan(response.text),
                }),
            });
            const response = result.response;
            if (!result.succeeded) {
              error = result.errorPayload({
                context: ` on turn ${turn + 1}/${maxTurns}`,
                turn: turn + 1,
              });
              turns.push(new Turn({ attacker, target: response }));
              if (progress && taskId !== null)
                await progress.updateAttack(taskId, turn + 1);
              setSpanAttrs(span, {
                "orq.redteam.adversarial_tokens": gen.usage?.totalTokens ?? 0,
                "orq.redteam.error_type": result.error?.errorType,
                "orq.redteam.finish_reason":
                  result.error?.errorType === "timeout"
                    ? "target_timeout"
                    : "target_error",
              });
              return "break";
            }
            setSpanAttrs(span, {
              output: truncateForSpan(response.text),
              "orq.redteam.output": truncateForSpan(response.text),
            });
            targetUsage = accumulateTargetUsage(targetUsage, response.usage);
            if (
              backtracked.length < maxBacktracks &&
              !objectiveAchieved &&
              !response.toolCalls.length
            ) {
              const [refused, judgeUsage] = await this.isRefusal(
                prompt,
                response,
                options.signal,
              );
              adversarialUsage = addUsage(adversarialUsage, judgeUsage);
              if (refused === null) refusalJudgeFailures++;
              if (refused) {
                backtracked.push(new Turn({ attacker, target: response }));
                messages.push(
                  { role: "assistant", content: prompt },
                  {
                    role: "user",
                    content: ADVERSARIAL_BACKTRACK_PROMPT.replace(
                      "{response}",
                      `<target_response>\n${xmlEscape(response.text)}\n</target_response>`,
                    ),
                  },
                );
                setSpanAttrs(span, {
                  input: truncateForSpan(prompt),
                  output: truncateForSpan(response.text),
                  "orq.redteam.adversarial_tokens":
                    attacker.usage?.totalTokens ?? 0,
                  "orq.redteam.finish_reason": "backtracked",
                });
                truncatedTurns = truncatedTurns.filter(
                  (number) => number !== turn + 1,
                );
                return "continue";
              }
            }
            turns.push(new Turn({ attacker, target: response }));
            messages.push(
              { role: "assistant", content: prompt },
              {
                role: "user",
                content: ADVERSARIAL_ANALYSIS_PROMPT.replace(
                  "{response}",
                  `<target_response>\n${xmlEscape(response.text)}\n</target_response>`,
                ),
              },
            );
            await progress?.updateAttack(taskId, turn + 1);
            setSpanAttrs(span, {
              input: truncateForSpan(prompt),
              output: truncateForSpan(response.text),
              "orq.redteam.adversarial_tokens": gen.usage?.totalTokens ?? 0,
              "orq.redteam.finish_reason": "ok",
            });
            return "completed";
          },
        );
        if (action === "break" || objectiveAchieved) break;
      }
    } finally {
      await progress?.finishAttack(taskId);
    }
    if (consecutive > 0 && !error && !turns.length)
      error = failure(
        `Adversarial LLM timed out after ${(cfg.attacker.timeoutMs / 1000).toFixed(0)}s with no turns completed`,
        "llm_error",
        "adversarial.timeout",
        { timeoutMs: cfg.attacker.timeoutMs },
        null,
      );
    const adv = adversarialUsage.calls > 0 ? adversarialUsage : null,
      tgt = targetUsage.calls > 0 ? targetUsage : null;
    return new OrchestratorResult({
      turns,
      maxTurns,
      objectiveAchieved,
      objectiveRationale,
      durationSeconds: (Date.now() - started) / 1000,
      tokenUsage: mergeAttackUsage(adv, tgt, bootstrapUsage),
      tokenUsageAdversarial: adv,
      tokenUsageTarget: tgt,
      tokenUsageBootstrap: bootstrapUsage,
      seedContext: seedContext ?? [],
      systemPrompt: system,
      ...(error ?? {}),
      truncatedTurns,
      backtrackedTurns: backtracked,
      refusalJudgeFailures,
    });
  }
}
