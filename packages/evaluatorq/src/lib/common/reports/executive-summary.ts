import { LLMCallConfig, type Usage } from "../../contracts.js";
import {
  type ChatCompletionOptions,
  executeChatCompletion,
} from "../llm-call.js";
import { pythonSplit, pythonStrip } from "../sanitize.js";
import {
  usageFromException,
  warnConfigRedirect,
  warnUnreadConfigFields,
} from "../structured-output.js";
import { withLlmSpan } from "../tracing.js";

export const EXECUTIVE_SUMMARY_SYSTEM_PROMPT = `You are an AI security expert writing the executive summary of an agent
assessment report for a technical but time-poor reader (an engineering lead or
security owner).

Write ONE paragraph, 2-4 sentences, following this arc:
  1. Scope: how many attacks/simulations were run, across how many categories.
  2. Verdict with tension: the headline success/resistance rate AND the
     failure/vulnerability count and severity in the same breath. Use
     "but"/"however" so the risk is not buried.
  3. The single sharpest concrete finding: name the one result that matters
     most, described as what the agent actually DID ("issued an unauthorized
     credit after a three-turn impersonation"), not the taxonomy label.
  4. The dominant risk pattern and its implication, grounded ONLY in the
     provided numbers (e.g. if multi-turn vulnerability rate exceeds
     single-turn, say conversation depth raises risk).

Rules:
- Lead with the numbers you are GIVEN. Never invent a statistic or a trend the
  facts do not state.
- Concrete over abstract: describe behavior, not codes.
- No preamble ("This report..."), no recommendations, no markdown, no headers.
  Prose only.
- If nothing notable was found (no failures/vulnerabilities), say so plainly in
  one sentence and stop. Do not manufacture risk.`;

export const EXECUTIVE_SUMMARY_MAX_TOKENS = 400;
export const EXECUTIVE_SUMMARY_TIMEOUT_MS = 120_000;

const READ_CONFIG_FIELDS = [
  "temperature",
  "maxTokens",
  "timeoutMs",
  "reasoningEffort",
  "extraKwargs",
  "extraBody",
];
const CALLER = "generateExecutiveSummary";

type Params = {
  temperature?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  extra_body?: Record<string, unknown>;
} & Record<string, unknown>;

export function truncateText(text: string, limit = 240): string {
  const collapsed = pythonSplit(text).join(" ");
  const chars = Array.from(collapsed);
  return chars.length <= limit
    ? collapsed
    : `${chars.slice(0, limit).join("").replace(/ +$/, "")}…`;
}

export interface ExecutiveSummary {
  text: string | null;
  usage: Usage | null;
}

/** Best-effort by contract: a failure yields `text: null` and never fails the report. */
export async function generateExecutiveSummary(
  facts: string,
  options: {
    llmClient: ChatCompletionOptions["client"];
    model: string;
    systemPrompt?: string;
    config?: LLMCallConfig | null;
  },
): Promise<ExecutiveSummary> {
  const {
    llmClient,
    model,
    systemPrompt = EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
    config,
  } = options;
  if (!facts || !pythonStrip(facts)) {
    return { text: null, usage: null };
  }
  try {
    warnUnreadConfigFields(config, READ_CONFIG_FIELDS, { caller: CALLER });
    warnConfigRedirect(config, { resolvedModel: model, caller: CALLER });
    const cfg = new LLMCallConfig({
      ...config?.setValues(
        "api",
        "temperature",
        "maxTokens",
        "timeoutMs",
        "extraKwargs",
        "extraBody",
        "reasoningEffort",
      ),
      model,
      maxTokens: config?.fieldsSet.has("maxTokens")
        ? config.maxTokens
        : EXECUTIVE_SUMMARY_MAX_TOKENS,
    });
    const {
      temperature,
      max_completion_tokens: maxCompletionTokens,
      reasoning_effort: reasoningEffort,
      extra_body: extraBody,
      ...extraKwargs
    } = cfg.requestParams({}, "chat_completions") as Params;
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: facts },
    ];
    const { response, usage } = await withLlmSpan(
      {
        model,
        inputMessages: messages,
        temperature,
        maxTokens: maxCompletionTokens,
        attributes: { "orq.llm.purpose": "executive_summary" },
      },
      (span) =>
        executeChatCompletion({
          client: llmClient,
          model,
          messages,
          span,
          timeoutMs: cfg.resolveTimeoutMs(EXECUTIVE_SUMMARY_TIMEOUT_MS),
          temperature,
          maxCompletionTokens,
          reasoningEffort,
          extraBody,
          extraKwargs: Object.keys(extraKwargs).length > 0 ? extraKwargs : null,
        }),
    );
    if (response.choices[0]?.finish_reason === "length") {
      console.warn(
        "Executive summary was truncated; omitting its text while retaining usage.",
      );
      return { text: null, usage };
    }
    const text = pythonStrip(response.choices[0]?.message?.content ?? "");
    return { text: text || null, usage };
  } catch (error) {
    console.warn("Failed to generate executive summary", error);
    return { text: null, usage: usageFromException(error) };
  }
}
