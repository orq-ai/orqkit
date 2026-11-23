import { isDeepStrictEqual } from "node:util";

import type OpenAI from "openai";

import {
  type ClassifyAnswer,
  type ClassifyOutcome,
  type ClassifyQuestion,
  ClassifyQuestionSchema,
  type ClassifyRequest,
  ClassifyRequestSchema,
  JudgeError,
  runClassify,
} from "../common/judge.js";
import {
  capText,
  effectiveTraceInputChars,
  fitClassifierInput,
  isJevModel,
  jevState,
  jevTextState,
  type ModelText,
} from "../common/model-input.js";
import { pyFloat } from "../common/reports/number-format.js";
import { withRetry } from "../common/retry.js";
import { checkRunActive, withRunLifecycle } from "../common/run-lifecycle.js";
import { pythonString } from "../common/sanitize.js";
import {
  type TraceDocument,
  toChatMessages,
} from "../common/trace-document.js";
import { LLMCallConfig } from "../contracts.js";
import { pythonJson } from "../formats/json.js";
import { matchesSelection } from "../trace-finder/classifier.js";
import type { CompiledQuery, TraceRecord } from "../trace-finder/models.js";
import {
  type LabelAnswer,
  LabelAnswerSchema,
  type LabelSpec,
} from "./models.js";
import {
  CODING_AGENT,
  CODING_CONVERSATION_LABELS,
  CODING_TOOL_LABELS,
} from "./presets.js";
import {
  detailedConversationView,
  jevToolActivityChunks,
  textToolActivityChunks,
  toolInventory,
} from "./transcript.js";
import type { UsageLedger } from "./usage.js";
export const MATCH_KEY = "__match__";
const repr = (value: unknown) => pythonString([value]).slice(1, -1);
const failed = (error: string): LabelAnswer =>
  LabelAnswerSchema.parse({
    value: null,
    confidence: null,
    probabilities: null,
    error,
  });
export function matchKey(index: number, count: number): string {
  return count === 1 ? MATCH_KEY : `__match_${index}__`;
}
export function mapLabelAnswer(
  question: ClassifyQuestion,
  answer: ClassifyAnswer,
): LabelAnswer {
  if (answer.type === "refusal")
    return failed(
      `classify model refused to answer the ${question.kind} question`,
    );
  if (answer.type !== question.kind)
    return failed(
      `classify answer type ${repr(answer.type)} does not match question kind ${repr(question.kind)}`,
    );
  if (question.kind === "noul") {
    if (answer.noul === null)
      return failed("noul answer is missing its probability");
    return LabelAnswerSchema.parse({
      value: answer.noul >= question.noulThreshold,
      confidence: answer.confidence,
      probabilities: { true: answer.noul, false: 1 - answer.noul },
      error: null,
    });
  }
  if (question.kind === "choice") {
    if (
      answer.choice === null ||
      !question.criteria ||
      Array.isArray(question.criteria) ||
      !Object.hasOwn(question.criteria, answer.choice)
    )
      return failed(
        `choice answer ${repr(answer.choice)} is missing or not in the question criteria`,
      );
    return LabelAnswerSchema.parse({
      value: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      error: null,
    });
  }
  if (answer.score === null || !Array.isArray(question.criteria))
    return failed(
      "score answer is missing or the question criteria is not an ordered level list",
    );
  const top = question.criteria.length - 1;
  if (top <= 0 || !(answer.score >= 0 && answer.score <= top))
    return failed(`score ${pyFloat(answer.score)} is outside the level range`);
  return LabelAnswerSchema.parse({
    value: Math.min(1, Math.max(0, answer.score / top)),
    confidence: answer.confidence,
    probabilities: null,
    error: null,
  });
}
export function mergeLabelChunks(
  name: string,
  answers: readonly LabelAnswer[],
): LabelAnswer {
  if (!answers.length) throw new RangeError("list index out of range");
  if (answers.length === 1 || name === "unfixed_error")
    return answers[answers.length - 1] as LabelAnswer;
  const answered = answers.filter((answer) => answer.error === null),
    found = answered.filter(
      (answer) =>
        answer.value !== false && answer.value !== 0 && answer.value !== "none",
    );
  if (found.length || answered.length === answers.length) {
    const candidates = found.length ? found : answered;
    return candidates.reduce((best, current) => {
      const score = (value: LabelAnswer) =>
        value.confidence ||
        Math.max(0, ...Object.values(value.probabilities ?? {}));
      return score(current) > score(best) ? current : best;
    });
  }
  return answers.find((answer) => answer.error !== null) as LabelAnswer;
}
export function readLabelAnswers(
  questions: Readonly<Record<string, ClassifyQuestion>>,
  answers: Readonly<Record<string, ClassifyAnswer>>,
): Record<string, LabelAnswer> {
  return Object.fromEntries(
    Object.entries(questions).flatMap(([name, question]) => {
      if (name === MATCH_KEY || name.startsWith("__match_")) return [];
      return [
        [
          name,
          Object.hasOwn(answers, name)
            ? mapLabelAnswer(question, answers[name] as ClassifyAnswer)
            : failed(`no answer returned for label ${repr(name)}`),
        ],
      ];
    }),
  );
}
export function populationMatch(
  questions: Readonly<Record<string, ClassifyQuestion>>,
  answers: Readonly<Record<string, ClassifyAnswer>>,
  keys: readonly string[],
  compiled: readonly CompiledQuery[],
): boolean | null {
  if (keys.length !== compiled.length)
    throw new Error(
      "population match keys and dimensions must have equal length",
    );
  const matches: boolean[] = [];
  for (const [index, key] of keys.entries()) {
    if (!Object.hasOwn(answers, key)) continue;
    if (!Object.hasOwn(questions, key))
      throw new Error(`Missing population match question: ${key}`);
    const mapped = mapLabelAnswer(
      questions[key] as ClassifyQuestion,
      answers[key] as ClassifyAnswer,
    );
    if (mapped.error === null)
      matches.push(
        matchesSelection(mapped.value, compiled[index] as CompiledQuery),
      );
  }
  return matches.length === compiled.length ? matches.every(Boolean) : null;
}

export function prepareState(
  state: ModelText | Record<string, unknown>,
  model: string,
  charCap: number,
): ModelText | Record<string, unknown> {
  if (isJevModel(model))
    return typeof state === "string" || state instanceof String
      ? jevTextState(state, { globalCharCap: charCap })
      : state;
  const rendered =
    typeof state === "string" || state instanceof String
      ? state
      : pythonJson(state, {
          ensureAscii: false,
          compact: true,
          sortKeys: true,
        });
  return capText(rendered, charCap)[0];
}
export function prepareClassifierState(
  trace: TraceRecord | TraceDocument,
  options: { model: string; charCap: number },
): ModelText | Record<string, unknown> {
  if (isJevModel(options.model))
    return jevState(toChatMessages(trace), { globalCharCap: options.charCap });
  return prepareState(
    detailedConversationView(trace, options.charCap),
    options.model,
    options.charCap,
  );
}
export async function classifyWithRetry(options: {
  client: OpenAI;
  model: string;
  cfg: LLMCallConfig;
  request: ClassifyRequest;
  usage?: UsageLedger;
  signal?: AbortSignal;
}): Promise<ClassifyOutcome> {
  const outcomes: ClassifyOutcome[] = [];
  try {
    return await withRunLifecycle(
      undefined,
      () =>
        withRetry(
          async () => {
            let outcome: ClassifyOutcome;
            try {
              outcome = await runClassify(options);
            } catch (error) {
              options.usage?.add("label", null);
              throw error;
            }
            checkRunActive();
            outcomes.push(outcome);
            options.usage?.add("label", outcome.tokenUsage);
            if (
              outcome.errorKind !== null &&
              [
                JudgeError.TIMEOUT,
                JudgeError.API_CONNECTION,
                JudgeError.API_STATUS,
              ].includes(
                outcome.errorKind as
                  | "timeout"
                  | "api_connection"
                  | "api_status",
              ) &&
              outcome.errorExc != null
            )
              throw outcome.errorExc;
            return outcome;
          },
          {
            maxAttempts: options.cfg.retryCount + 1,
            label: "insights label classify",
            signal: options.signal,
          },
        ),
      options.signal,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    checkRunActive();
    if (!outcomes.length) throw error;
    return outcomes[outcomes.length - 1] as ClassifyOutcome;
  }
}
export async function askLabels(
  state: ModelText | Record<string, unknown>,
  specs: readonly LabelSpec[],
  options: {
    client: OpenAI;
    model: string;
    cfg: LLMCallConfig;
    usage?: UsageLedger;
    charCap: number;
    signal?: AbortSignal;
  },
): Promise<readonly [Record<string, LabelAnswer>, string | null]> {
  let prepared = prepareState(state, options.model, options.charCap);
  const plain = (
    value: ModelText | Record<string, unknown>,
  ): string | Record<string, unknown> =>
    value instanceof String ? String(value) : value;
  let questions = Object.fromEntries(
    specs.map((spec) => [spec.name, spec.toQuestion(plain(prepared))]),
  );
  prepared = fitClassifierInput(prepared, {
    model: options.model,
    questions,
    globalCharCap: options.charCap,
  });
  questions = Object.fromEntries(
    specs.map((spec) => [spec.name, spec.toQuestion(plain(prepared))]),
  );
  const outcome = await classifyWithRetry({
    ...options,
    request: ClassifyRequestSchema.parse({ state: plain(prepared), questions }),
  });
  if (outcome.errorKind !== null || outcome.response === null) {
    const message =
      outcome.errorMessage ||
      outcome.errorKind ||
      "classify reply produced no response";
    return [
      Object.fromEntries(specs.map((spec) => [spec.name, failed(message)])),
      message,
    ];
  }
  return [readLabelAnswers(questions, outcome.response.answers), null];
}

export interface LabelOutcome {
  trace: TraceRecord | TraceDocument;
  answers: Record<string, LabelAnswer>;
  matched: boolean | null;
  error: string | null;
}
export interface LabelTracesOptions {
  labels: readonly LabelSpec[];
  compiled?: readonly CompiledQuery[] | null;
  client: OpenAI;
  model: string;
  parallelism?: number;
  cfg?: LLMCallConfig;
  onProgress?: (done: number, total: number) => void | Promise<void>;
  usage?: UsageLedger;
  coding?: boolean;
  codingLabels?: readonly LabelSpec[] | null;
  traceInputChars?: number;
  signal?: AbortSignal;
}
async function labelOne(
  trace: TraceRecord | TraceDocument,
  options: LabelTracesOptions & { cfg: LLMCallConfig; traceInputChars: number },
): Promise<LabelOutcome> {
  const answers: Record<string, LabelAnswer> = {},
    selected = options.codingLabels ?? [
      ...CODING_CONVERSATION_LABELS,
      ...CODING_TOOL_LABELS,
    ],
    conversationCoding = selected.filter((spec) =>
      CODING_CONVERSATION_LABELS.some((candidate) =>
        isDeepStrictEqual(spec, candidate),
      ),
    ),
    toolCoding = selected.filter((spec) =>
      CODING_TOOL_LABELS.some((candidate) =>
        isDeepStrictEqual(spec, candidate),
      ),
    );
  let coding = false;
  if (options.coding) {
    const [detected] = await askLabels(toolInventory(trace), [CODING_AGENT], {
      ...options,
      charCap: options.traceInputChars,
    });
    Object.assign(answers, detected);
    const verdict = detected[CODING_AGENT.name];
    coding = Boolean(
      verdict && verdict.error === null && verdict.value === true,
    );
  }
  let state = prepareClassifierState(trace, {
    model: options.model,
    charCap: options.traceInputChars,
  });
  const specs = [...options.labels, ...(coding ? conversationCoding : [])],
    compiled = options.compiled ?? [],
    keys = compiled.map((_, index) => matchKey(index, compiled.length));
  const plain = (
    value: ModelText | Record<string, unknown>,
  ): string | Record<string, unknown> =>
    value instanceof String ? String(value) : value;
  const makeQuestions = (value: ModelText | Record<string, unknown>) =>
    Object.fromEntries([
      ...specs.map(
        (spec) => [spec.name, spec.toQuestion(plain(value))] as const,
      ),
      ...compiled.map(
        (dimension, index) =>
          [
            keys[index] as string,
            ClassifyQuestionSchema.parse({
              ...dimension.task,
              state: plain(value),
            }),
          ] as const,
      ),
    ]);
  let questions = makeQuestions(state);
  state = fitClassifierInput(state, {
    model: options.model,
    questions,
    globalCharCap: options.traceInputChars,
  });
  questions = makeQuestions(state);
  const conversation = async (): Promise<
    readonly [Readonly<Record<string, ClassifyAnswer>> | null, string | null]
  > => {
    if (!Object.keys(questions).length) return [null, null];
    const outcome = await classifyWithRetry({
      ...options,
      request: ClassifyRequestSchema.parse({ state: plain(state), questions }),
    });
    if (outcome.errorKind !== null || outcome.response === null)
      return [
        null,
        outcome.errorMessage ||
          outcome.errorKind ||
          "classify reply produced no response",
      ];
    return [outcome.response.answers, null];
  };
  const toolCalls = async (): Promise<Record<string, LabelAnswer>> => {
    if (!coding || !toolCoding.length) return {};
    const payloads = Object.fromEntries(
      toolCoding.map((spec) => [spec.name, spec.toQuestion("")]),
    );
    const chunks = isJevModel(options.model)
      ? jevToolActivityChunks(trace, {
          traceInputChars: options.traceInputChars,
          questionPayloads: payloads,
        })
      : textToolActivityChunks(trace, {
          traceInputChars: options.traceInputChars,
          questionPayloads: payloads,
        });
    const results = await Promise.all(
      chunks.map((chunk) =>
        askLabels(chunk, toolCoding, {
          ...options,
          charCap: options.traceInputChars,
        }),
      ),
    );
    return Object.fromEntries(
      toolCoding.map((spec) => [
        spec.name,
        mergeLabelChunks(
          spec.name,
          results.map(([result]) => result[spec.name] as LabelAnswer),
        ),
      ]),
    );
  };
  const settled = await Promise.allSettled([
    conversation(),
    toolCalls(),
  ] as const);
  for (const item of settled) if (item.status === "rejected") throw item.reason;
  const [raw, error] = (
      settled[0] as PromiseFulfilledResult<
        readonly [
          Readonly<Record<string, ClassifyAnswer>> | null,
          string | null,
        ]
      >
    ).value,
    toolAnswers = (
      settled[1] as PromiseFulfilledResult<Record<string, LabelAnswer>>
    ).value;
  Object.assign(answers, toolAnswers);
  if (error !== null) {
    for (const spec of specs) answers[spec.name] = failed(error);
    return { trace, answers, matched: null, error };
  }
  if (raw === null) return { trace, answers, matched: null, error: null };
  Object.assign(answers, readLabelAnswers(questions, raw));
  return {
    trace,
    answers,
    matched: compiled.length
      ? populationMatch(questions, raw, keys, compiled)
      : null,
    error: null,
  };
}
export async function labelTraces(
  traces: readonly (TraceRecord | TraceDocument)[],
  options: LabelTracesOptions,
): Promise<LabelOutcome[]> {
  const parallelism = options.parallelism ?? 100;
  if (!Number.isInteger(parallelism) || parallelism <= 0)
    throw new RangeError("parallelism must be greater than zero");
  const traceInputChars =
      options.traceInputChars ?? (await effectiveTraceInputChars()),
    cfg =
      options.cfg ??
      new LLMCallConfig({ model: options.model, timeoutMs: 90000 }),
    results: LabelOutcome[] = new Array(traces.length);
  let next = 0,
    completed = 0;
  return withRunLifecycle(
    parallelism,
    async () => {
      const worker = async () => {
        while (next < traces.length) {
          options.signal?.throwIfAborted();
          const index = next++,
            trace = traces[index] as TraceRecord | TraceDocument;
          try {
            results[index] = await labelOne(trace, {
              ...options,
              cfg,
              traceInputChars,
            });
            checkRunActive();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            checkRunActive();
            const message =
              error instanceof Error
                ? error.message || error.name
                : String(error);
            results[index] = {
              trace,
              answers: Object.fromEntries(
                options.labels.map((label) => [label.name, failed(message)]),
              ),
              matched: null,
              error: message,
            };
          } finally {
            if (options.onProgress) {
              completed++;
              try {
                await options.onProgress(completed, traces.length);
              } catch (error) {
                console.warn(
                  `Insights label progress callback failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }
        }
      };
      const tasks = Array.from(
        { length: Math.min(parallelism, traces.length) },
        () => worker(),
      );
      const finished = await Promise.allSettled(tasks);
      const failure = finished.find((item) => item.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return results;
    },
    options.signal,
  );
}
