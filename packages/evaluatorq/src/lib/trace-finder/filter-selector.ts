import type OpenAI from "openai";
import { z } from "zod/v4";

import {
  type ClassifyOutcome,
  type ClassifyQuestion,
  ClassifyQuestionSchema,
  type ClassifyResponse,
  ClassifyResponseSchema,
  runClassify,
} from "../common/judge.js";
import { classifyRequestBody } from "../common/llm-call.js";
import { withoutClientRetries, withRetry } from "../common/retry.js";
import { pythonString, pythonStrip } from "../common/sanitize.js";
import {
  generateStructured,
  sumStructuredUsage,
} from "../common/structured-output.js";
import { LLMCallConfig, type Usage } from "../contracts.js";
import { pythonRegexEngine } from "../signals/python-regex.js";
import {
  TimeFilters,
  tightenStrictBounds,
  WireNumericSchema,
} from "./compiler.js";
import { enabled as debugEnabled } from "./debug.js";
import {
  FACET_NAMES,
  type FacetCatalogue,
  type FacetName,
  FacetSelection,
  FILTER_OR_JUDGMENT_RULE,
  NumericFilters,
} from "./models.js";

export const FILTER_TIMEOUT_MS = 30000;
export const NO_FILTER_LABEL = "none";
export const MAX_FILTER_QUESTIONS = 100;
const STATUS_NOTE =
  ' Status is the recorded trace status, not an error inside the conversation: "tool errors" or "errors" alone do not constrain trace status.';
export class FilterSelectionError extends Error {
  override readonly name = "FilterSelectionError";
}
export class FilterSelectionResult {
  readonly selection: FacetSelection;
  readonly response: ClassifyResponse | null;
  readonly error: string | null;
  readonly numeric: NumericFilters | null;
  readonly time: TimeFilters | null;
  readonly usage: Usage | null;
  constructor(
    selection: FacetSelection,
    options: {
      response?: ClassifyResponse | null;
      error?: string | null;
      numeric?: NumericFilters | null;
      time?: TimeFilters | null;
      usage?: Usage | null;
    } = {},
  ) {
    this.selection = selection;
    this.response = options.response ?? null;
    this.error = options.error ?? null;
    this.numeric = options.numeric ?? null;
    this.time = options.time ?? null;
    this.usage = options.usage ?? null;
    Object.freeze(this);
  }
}
const nativeFacet = (name: FacetName) =>
  name.replace(/_([a-z])/g, (_, char: string) =>
    char.toUpperCase(),
  ) as keyof FacetCatalogue;
const valuesFor = (catalogue: FacetCatalogue, name: FacetName) =>
  catalogue[nativeFacet(name)] as readonly string[];
const repr = (value: unknown) => pythonString([value]).slice(1, -1);
export function filterChoiceMap(
  values: readonly string[],
): Record<string, string | null> {
  let none = NO_FILTER_LABEL;
  while (values.includes(none)) none += "_";
  return Object.fromEntries([
    [none, null],
    ...values.map((value) => [value, value]),
  ]);
}
export function filterChoiceDescription(
  name: string,
  value: string | null,
): string {
  return value === null
    ? `Do not filter by ${name.replaceAll("_", " ")}.`
    : `Filter ${name.replaceAll("_", " ")} to the exact dataset value ${repr(value)}.`;
}
export interface CatalogueQuestions {
  choices: Record<string, Record<string, string | null>>;
  binaryValues: Record<string, readonly [FacetName, string]>;
  questions: Record<string, ClassifyQuestion>;
}
export function questionsForCatalogue(
  catalogue: FacetCatalogue,
  query: string,
): CatalogueQuestions {
  const choices: CatalogueQuestions["choices"] = {},
    binaryValues: CatalogueQuestions["binaryValues"] = {},
    questions: CatalogueQuestions["questions"] = {};
  for (const name of FACET_NAMES) {
    const values = valuesFor(catalogue, name);
    if (values.length === 0) continue;
    const mentioned = values
      .map((value, index) => ({ value, index }))
      .filter(({ value }) =>
        pythonRegexEngine(
          `(?i)(?<!\\w)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`,
        ).test(query),
      );
    if (mentioned.length > 1) {
      for (const { value, index } of mentioned) {
        const key = `${name}_${index}`;
        binaryValues[key] = [name, value];
        questions[key] = ClassifyQuestionSchema.parse({
          kind: "noul",
          instructions: `Does the query explicitly request ${name.replaceAll("_", " ")} value ${repr(value)}? Answer yes when it is one of several requested alternatives. Follow the rule in state: answer no when the value is only implied by what happened in the conversation.`,
          state: {},
        });
      }
      continue;
    }
    const map = filterChoiceMap(values),
      none = Object.entries(map).find(
        ([, value]) => value === null,
      )?.[0] as string;
    choices[name] = map;
    questions[name] = ClassifyQuestionSchema.parse({
      kind: "choice",
      instructions:
        `Identify the ${name.replaceAll("_", " ")} value explicitly requested by the user query. Choose ${repr(none)} when the query does not constrain this dimension. Follow the rule in state: choose ${repr(none)} when the value is only implied by what happened in the conversation, or when the query is an aggregate question.` +
        (name === "status" ? STATUS_NOTE : ""),
      criteria: Object.fromEntries(
        Object.entries(map).map(([label, value]) => [
          label,
          filterChoiceDescription(name, value),
        ]),
      ),
      state: {},
    });
  }
  return { choices, binaryValues, questions };
}
export function selectionFromAnswers(
  response: ClassifyResponse,
  { choices, binaryValues, questions }: CatalogueQuestions,
): FacetSelection {
  const selected = Object.fromEntries(
    FACET_NAMES.map((name) => [name, new Set<string>()]),
  ) as Record<FacetName, Set<string>>;
  for (const key of Object.keys(questions)) {
    const answer = response.answers[key];
    if (!answer)
      throw new FilterSelectionError(
        `The classifier returned no answer for filter dimension: ${key}`,
      );
    const binary = binaryValues[key];
    if (binary) {
      const [name, value] = binary;
      if (answer.type !== "noul" || answer.noul === null)
        throw new FilterSelectionError(
          `The classifier returned an invalid ${key} filter answer type: ${repr(answer.type)}`,
        );
      if (answer.noul >= 0.5) selected[name].add(value);
      continue;
    }
    const map = choices[key] as Record<string, string | null>;
    if (answer.type !== "choice")
      throw new FilterSelectionError(
        `The classifier returned an invalid ${key} filter answer type: ${repr(answer.type)}`,
      );
    if (answer.choice === null || !Object.hasOwn(map, answer.choice))
      throw new FilterSelectionError(
        `The classifier selected an unavailable ${key} choice: ${repr(answer.choice)}`,
      );
    const value = map[answer.choice];
    if (value !== null && value !== undefined)
      selected[key as FacetName].add(value);
  }
  return new FacetSelection(selected);
}
export async function selectFilters(
  client: OpenAI,
  model: string,
  catalogue: FacetCatalogue,
  query: string,
  options: { config?: LLMCallConfig | null } = {},
): Promise<FacetSelection> {
  return (
    await selectFiltersWithResponse(client, model, catalogue, query, options)
  ).selection;
}
export async function selectFiltersWithResponse(
  client: OpenAI,
  model: string,
  catalogue: FacetCatalogue,
  query: string,
  options: { config?: LLMCallConfig | null } = {},
): Promise<FilterSelectionResult> {
  const normalized = pythonStrip(query);
  if (!normalized)
    throw new TypeError(
      "Enter a semantic trace query before selecting filters.",
    );
  const built = questionsForCatalogue(catalogue, normalized),
    count = Object.keys(built.questions).length;
  if (count === 0) return new FilterSelectionResult(new FacetSelection());
  if (count > MAX_FILTER_QUESTIONS)
    throw new FilterSelectionError(
      `trace filter selection needs ${count} questions; maximum is ${MAX_FILTER_QUESTIONS}`,
    );
  const request = {
      state: { query: normalized, rule: FILTER_OR_JUDGMENT_RULE },
      questions: built.questions,
    },
    config =
      options.config ??
      new LLMCallConfig({ model, timeoutMs: FILTER_TIMEOUT_MS });
  if (debugEnabled())
    console.error(
      "Trace finder filter classify request",
      model,
      JSON.stringify(
        classifyRequestBody(model, request.state, request.questions),
      ),
    );
  let outcome: ClassifyOutcome;
  try {
    outcome = await withRetry(
      async () => {
        const result = await runClassify({
          client: withoutClientRetries(client),
          model,
          cfg: config,
          request,
        });
        if (debugEnabled())
          console.error(
            "Trace finder filter classify response",
            model,
            result.rawContent || JSON.stringify(result.response),
            result.errorMessage,
          );
        if (result.errorKind !== null && result.errorExc instanceof Error)
          throw result.errorExc;
        return result;
      },
      {
        maxAttempts: config.retryCount + 1,
        label: `filter selection[${model}]`,
      },
    );
  } catch (error) {
    throw new FilterSelectionError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (outcome.errorKind !== null || outcome.response === null)
    throw new FilterSelectionError(
      outcome.errorMessage || "The classifier returned no filter selection.",
    );
  return new FilterSelectionResult(
    selectionFromAnswers(outcome.response, built),
    {
      response: ClassifyResponseSchema.parse(structuredClone(outcome.response)),
      usage: outcome.tokenUsage,
    },
  );
}
export async function selectLlmFiltersWithResponse(
  client: OpenAI,
  model: string,
  catalogue: FacetCatalogue,
  query: string,
  options: { now: string | Date; config?: LLMCallConfig | null },
): Promise<FilterSelectionResult> {
  const normalized = pythonStrip(query);
  if (!normalized)
    throw new TypeError(
      "Enter a semantic trace query before selecting filters.",
    );
  const current = new TimeFilters({ start: options.now }).start;
  if (current === null) throw new TypeError("now must be timezone-aware");
  const choices = Object.fromEntries(
    FACET_NAMES.map((name) => {
      const values = [...new Set(valuesFor(catalogue, name))];
      let none = NO_FILTER_LABEL;
      while (values.includes(none)) none += "_";
      return [name, [...values, none]];
    }),
  ) as Record<FacetName, string[]>;
  const facets = Object.fromEntries(
    FACET_NAMES.map((name) => [name, z.array(z.enum(choices[name]))]),
  ) as Record<FacetName, z.ZodArray<z.ZodEnum<Record<string, string>>>>;
  const schema = z.strictObject({
    ...facets,
    numeric: WireNumericSchema,
    calendar_day: z.boolean(),
    start: z.iso.datetime({ offset: true }).nullable(),
    end: z.iso.datetime({ offset: true }).nullable(),
  });
  const messages: { role: string; content: string }[] = [
      {
        role: "system",
        content:
          FILTER_SELECTION_INSTRUCTIONS + current.replace(/Z$/, "+00:00"),
      },
      { role: "user", content: normalized },
    ],
    usages: Usage[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await generateStructured(client, {
      model,
      messages,
      responseFormat: { name: "LLMFilterSelectionWire", schema },
      maxTokens: 1600,
      label: "trace_finder.filters",
      api: "responses",
      config: options.config,
    });
    if (result.usage !== null) usages.push(result.usage);
    if (result.parsed === null)
      throw new FilterSelectionError(
        `Filter selector returned no structured result. Raw: ${Array.from(result.raw).slice(0, 300).join("")}`,
      );
    try {
      const wire = schema.parse(result.parsed),
        selection = new FacetSelection(
          Object.fromEntries(
            FACET_NAMES.map((name) => {
              const values = wire[name] as string[];
              return [
                name,
                values.includes(choices[name].at(-1) as string)
                  ? new Set<string>()
                  : new Set(values),
              ];
            }),
          ),
        ),
        numeric = tightenStrictBounds(
          normalized,
          new NumericFilters(wire.numeric),
        ),
        time =
          wire.start !== null || wire.end !== null
            ? new TimeFilters({
                start: wire.start,
                end: wire.end,
                calendarDay: wire.calendar_day,
              })
            : null;
      return new FilterSelectionResult(selection, {
        numeric,
        time,
        usage: sumStructuredUsage(usages),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt)
        throw new FilterSelectionError(
          `Filter selector produced an invalid plan: ${detail}`,
          { cause: error },
        );
      messages.push(
        {
          role: "assistant",
          content: result.raw || JSON.stringify(result.parsed),
        },
        {
          role: "user",
          content: `Your selection was invalid: ${detail}. Correct it.`,
        },
      );
    }
  }
  throw new Error("unreachable LLM filter retry state");
}
const FILTER_SELECTION_INSTRUCTIONS =
  "Select only metadata values explicitly requested by the user. Every facet answer MUST be one of its exact offered catalogue strings or its no-filter label. Never infer status or other facets. For models, a literal provider/namespace prefix in the query may be stripped only to match an exact offered catalogue value; return that full offered value. Extract inclusive integer token and duration bounds, keeping fields null unless explicitly constrained. Return calendar time as nullable ISO-8601 UTC bounds, with null for each absent bound and both null when no time filter is requested. For whole-calendar-day requests set calendar_day true and use an exclusive next-day UTC midnight end, including relative days. Set calendar_day false when the request has explicit clock-time semantics or no calendar-time constraint, and preserve any exact clock-time instants. A date-only bound is a whole calendar day, not a time of day. Resolve relative dates against current UTC time: ";
