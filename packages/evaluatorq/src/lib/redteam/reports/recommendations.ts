import type OpenAI from "openai";
import { z } from "zod/v4";

import {
  coerceStr,
  coerceStrList,
  extractJsonFromResponse,
} from "../../common/extract-json.js";
import { pythonFixed } from "../../common/jury.js";
import { coerceContentText } from "../../common/messages.js";
import { SEVERITY_WEIGHTS } from "../../common/reports/palette.js";
import { pythonStrip, xmlEscape } from "../../common/sanitize.js";
import {
  generateStructured,
  logStructuredUsage,
  sumStructuredUsage,
  usageFromException,
} from "../../common/structured-output.js";
import type { Usage } from "../../contracts.js";
import {
  type LLMConfig,
  PIPELINE_CONFIG,
  RedTeamRecommendationConfig,
} from "../config.js";
import { OWASP_CATEGORY_NAMES } from "../contracts.js";
import type {
  FocusAreaRecommendation,
  RedTeamReport,
  RedTeamResult,
} from "./models.js";
import {
  CONDENSE_SYSTEM_PROMPT,
  RECOMMENDATIONS_SYSTEM_PROMPT,
} from "./recommendation-prompts.js";
import { extractPrompt, extractResponse } from "./utils.js";

const ResponseSchema = z.object({
  recommendations: z.preprocess(coerceStrList, z.array(z.string())).default([]),
  patterns_observed: z.preprocess(coerceStr, z.string()).default(""),
});
const CondensedSchema = z.object({
  analysis: z.preprocess(coerceStr, z.string()).default(""),
});
const chars = (text: string) => Array.from(text);
function truncate(text: string, limit: number): string {
  const value = chars(text);
  return value.length <= limit ? text : `${value.slice(0, limit).join("")}...`;
}
export function recommendationTurns(result: RedTeamResult): [string, string][] {
  const pairs: [string, string][] = [];
  let pending: string | null = null;
  for (const message of result.messages) {
    if (message.role === "user") {
      if (pending != null) pairs.push([pending, ""]);
      pending = coerceContentText(message.content);
    } else if (message.role === "assistant" && pending != null) {
      pairs.push([pending, coerceContentText(message.content)]);
      pending = null;
    }
  }
  if (pending != null) pairs.push([pending, ""]);
  return pairs;
}
export function formatRecommendationTrace(
  result: RedTeamResult,
  config: RedTeamRecommendationConfig,
  maxContentChars?: number,
): string {
  const limit = maxContentChars ?? config.maxAttackChars;
  const explanation = truncate(
    result.evaluation?.explanation ?? "",
    maxContentChars == null
      ? config.maxExplanationChars
      : Math.min(config.maxExplanationChars, maxContentChars),
  );
  const turns = recommendationTurns(result);
  const lines = [
    "<trace>",
    `  <technique>${xmlEscape(result.attack.attackTechnique)}</technique>`,
  ];
  if (turns.length > 1) {
    for (const [index, [user, assistant]] of turns.entries()) {
      const reply =
        index === turns.length - 1 && result.response
          ? result.response
          : assistant;
      lines.push(
        `  <turn index="${index + 1}">`,
        `    <prompt>${xmlEscape(truncate(user, limit))}</prompt>`,
        `    <response>${xmlEscape(truncate(reply, limit))}</response>`,
        "  </turn>",
      );
    }
  } else
    lines.push(
      `  <prompt>${xmlEscape(truncate(extractPrompt(result), limit))}</prompt>`,
      `  <response>${xmlEscape(truncate(extractResponse(result), limit))}</response>`,
    );
  if (explanation)
    lines.push(`  <evaluator>${xmlEscape(explanation)}</evaluator>`);
  lines.push("</trace>");
  return lines.join("\n");
}
export function formatRecommendationTraceToBudget(
  result: RedTeamResult,
  config: RedTeamRecommendationConfig,
  maxChars: number,
): string {
  let low = 0,
    high = maxChars,
    best = "";
  while (low <= high) {
    const limit = Math.floor((low + high) / 2),
      candidate = formatRecommendationTrace(result, config, limit);
    if (chars(candidate).length <= maxChars) {
      best = candidate;
      low = limit + 1;
    } else high = limit - 1;
  }
  return best;
}
export function buildRecommendationPrompt(
  category: string,
  name: string,
  rate: number,
  traces: string[],
): string {
  return `Category: ${category} - ${name}\nVulnerability rate: ${pythonFixed(rate * 100, 0)}%\nNumber of failed traces analyzed: ${traces.length}\n\nFailed attack traces (agent was VULNERABLE in each):\n\n${traces.join("\n\n")}`;
}
export function truncatePromptAtTraceBoundary(
  text: string,
  maxChars: number,
): string {
  if (chars(text).length <= maxChars) return text;
  if (maxChars <= 0) return "";
  let prefix = chars(text).slice(0, maxChars).join("");
  const angle = prefix.lastIndexOf("<");
  if (angle > prefix.lastIndexOf(">"))
    prefix = prefix.slice(0, angle).trimEnd();
  let depth = 0,
    start: number | null = null,
    end: number | null = null,
    cursor = 0;
  while (cursor < prefix.length) {
    const opening = prefix.indexOf("<trace>", cursor),
      closing = prefix.indexOf("</trace>", cursor);
    if (opening < 0 && closing < 0) break;
    if (closing < 0 || (opening >= 0 && opening < closing)) {
      if (depth === 0) start = opening;
      depth++;
      cursor = opening + 7;
    } else if (depth > 0) {
      depth--;
      cursor = closing + 8;
      if (depth === 0) end = cursor;
    } else cursor = closing + 8;
  }
  return end != null
    ? prefix.slice(0, end)
    : start != null
      ? prefix.slice(0, start).trimEnd()
      : prefix;
}
export function computeRiskScore(
  rate: number | null,
  results: readonly RedTeamResult[],
): number {
  const vulnerable = results.filter((row) => row.vulnerable);
  const averageWeight =
    vulnerable.reduce(
      (sum, row) => sum + SEVERITY_WEIGHTS[row.attack.severity],
      0,
    ) / vulnerable.length;
  return rate == null || !vulnerable.length ? 0 : rate * averageWeight;
}
export function computeTopRiskAreas(report: RedTeamReport, maxAreas: number) {
  const vulnerabilities = new Map<string, [string, string]>();
  for (const [id, row] of Object.entries(report.summary.byVulnerability))
    for (const categories of Object.values(row.frameworkCategories))
      for (const category of categories)
        if (!vulnerabilities.has(category))
          vulnerabilities.set(category, [id, row.vulnerabilityName]);
  return Object.entries(report.summary.byCategory)
    .filter(([, row]) => row.vulnerabilitiesFound > 0)
    .map(([category, row]) => {
      const results = report.results.filter(
        (result) => result.attack.category === category,
      );
      const [vulnerability, vulnerabilityName] = vulnerabilities.get(
        category,
      ) ?? ["", ""];
      return {
        category,
        categoryName: OWASP_CATEGORY_NAMES[category] ?? category,
        vulnerability,
        vulnerabilityName,
        vulnerabilityRate: row.vulnerabilityRate,
        riskScore: computeRiskScore(row.vulnerabilityRate, results),
        vulnerableResults: results.filter((result) => result.vulnerable),
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, maxAreas);
}
export async function generateFocusAreaRecommendations(
  report: RedTeamReport,
  llmClient: OpenAI,
  model: string,
  options: {
    recommendations?: RedTeamRecommendationConfig;
    llmKwargs?: Record<string, unknown> | null;
    cfg?: LLMConfig;
  } = {},
): Promise<[FocusAreaRecommendation[], Usage | null]> {
  const cfg = options.cfg ?? PIPELINE_CONFIG,
    limits = options.recommendations ?? new RedTeamRecommendationConfig();
  const generated: FocusAreaRecommendation[] = [],
    usages: (Usage | null)[] = [];
  const { extra_body: callerBody, ...extraKwargs } = {
    ...cfg.evaluator.extraKwargs,
    ...options.llmKwargs,
  };
  const extraBody = {
    ...cfg.retryExtraBody(llmClient),
    ...cfg.evaluator.extraBody,
    ...(callerBody as Record<string, unknown> | undefined),
  };
  const callOptions = {
    temperature: cfg.evaluator.temperature,
    reasoningEffort: cfg.evaluator.reasoningEffort,
    extraKwargs,
    extraBody,
  };
  for (const area of computeTopRiskAreas(report, limits.maxAreas)) {
    const vulnerable = area.vulnerableResults;
    if (!vulnerable.length) continue;
    const shuffled = [...vulnerable];
    if (shuffled.length > limits.maxAttacks)
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [
          shuffled[j] as RedTeamResult,
          shuffled[i] as RedTeamResult,
        ];
      }
    const sampled = shuffled.slice(0, limits.maxAttacks);
    const blocks = await Promise.all(
      sampled.map(async (result) => {
        const block = formatRecommendationTrace(result, limits);
        if (chars(block).length <= limits.condenseAboveChars) return block;
        let usage: Usage | null = null;
        try {
          const answer = await generateStructured(llmClient, {
            ...callOptions,
            model,
            messages: [
              { role: "system", content: CONDENSE_SYSTEM_PROMPT },
              { role: "user", content: block },
            ],
            responseFormat: {
              name: "CondensedAttackLLMResponse",
              schema: CondensedSchema,
            },
            maxTokens: limits.condenseMaxTokens,
            label: "redteam_recommendations_condense",
          });
          usage = answer.usage;
          const parsed =
            answer.parsed ??
            CondensedSchema.parse(
              JSON.parse(extractJsonFromResponse(answer.raw)),
            );
          const analysis = pythonStrip(parsed.analysis);
          if (!analysis) throw new Error("condense returned an empty analysis");
          return `<trace>\n  <technique>${xmlEscape(result.attack.attackTechnique)}</technique>\n  <analysis>${xmlEscape(analysis)}</analysis>\n</trace>`;
        } catch (error) {
          usage = usage ?? usageFromException(error);
          console.warn(
            `Failed to condense a ${chars(block).length}-char attack for ${result.attack.category}; truncating it to ${limits.condenseAboveChars} chars instead`,
            error,
          );
          return formatRecommendationTraceToBudget(
            result,
            limits,
            limits.condenseAboveChars,
          );
        } finally {
          usages.push(usage);
        }
      }),
    );
    let prompt = buildRecommendationPrompt(
      area.category,
      area.categoryName,
      area.vulnerabilityRate ?? 0,
      blocks,
    );
    if (chars(prompt).length > limits.maxAreaPromptChars) {
      console.warn(
        `Focus-area prompt for ${area.category} is ${chars(prompt).length} chars after condensing; truncating to maxAreaPromptChars=${limits.maxAreaPromptChars}`,
      );
      prompt = truncatePromptAtTraceBoundary(prompt, limits.maxAreaPromptChars);
    }
    try {
      const answer = await generateStructured(llmClient, {
        ...callOptions,
        model,
        messages: [
          {
            role: "system",
            content: RECOMMENDATIONS_SYSTEM_PROMPT.replace(
              "{max_suggestions}",
              String(limits.maxSuggestions),
            ),
          },
          { role: "user", content: prompt },
        ],
        responseFormat: {
          name: "FocusAreaLLMResponse",
          schema: ResponseSchema,
        },
        maxTokens: limits.maxTokens,
        label: "redteam_recommendations",
      });
      usages.push(answer.usage);
      const parsed =
        answer.parsed ??
        ResponseSchema.parse(JSON.parse(extractJsonFromResponse(answer.raw)));
      generated.push({
        category: area.category,
        categoryName: area.categoryName,
        riskScore: area.riskScore,
        tracesAnalyzed: sampled.length,
        recommendations: parsed.recommendations
          .filter(Boolean)
          .slice(0, limits.maxSuggestions),
        patternsObserved: parsed.patterns_observed,
      });
    } catch (error) {
      usages.push(usageFromException(error));
      console.warn(
        `Failed to generate recommendations for ${area.category}`,
        error,
      );
    }
  }
  const total = sumStructuredUsage(usages);
  logStructuredUsage(total, { phase: "Red-team recommendations" });
  return [generated, total];
}
