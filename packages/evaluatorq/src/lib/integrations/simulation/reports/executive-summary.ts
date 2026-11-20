import {
  MissingLLMCredentialsError,
  resolveLlmClient,
} from "../../../common/llm-client.js";
import {
  generateExecutiveSummary,
  truncateText,
} from "../../../common/reports/executive-summary.js";
import { pyPercent } from "../../../common/reports/number-format.js";
import { sumStructuredUsage } from "../../../common/structured-output.js";
import type { LLMCallConfig } from "../../../contracts.js";
import type { SimulationRun } from "../run-store.js";
import type { ReportResult } from "./helpers.js";
export function buildSimulationFacts(results: readonly ReportResult[]): string {
  if (!results.length) return "";
  const achieved = results.filter((result) => result.goal_achieved).length;
  const lines = [
    `Total simulations: ${results.length}`,
    `Goals achieved: ${achieved} (${pyPercent(achieved / results.length)})`,
    `Goals failed: ${results.length - achieved}`,
  ];
  const counts = new Map<string, number>();
  for (const result of results)
    for (const rule of result.rules_broken)
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (top) {
    lines.push(
      `Most-broken rule: ${top[0]} (broken in ${top[1]} simulation(s))`,
      "Rules broken (by frequency): " +
        sorted.map(([rule, count]) => `${rule}: ${count}`).join(", "),
    );
    const example = results.find(
      (result) => result.rules_broken.includes(top[0]) && !result.goal_achieved,
    );
    if (example?.reason)
      lines.push(`Example failure: ${truncateText(example.reason)}`);
  }
  return lines.join("\n");
}
const SYSTEM_PROMPT = `Write one concise paragraph summarizing an agent simulation report for an engineering lead. State the supplied simulation count, goal-completion rate and failure count. Describe the most important observed failure and its implication using only the supplied facts. Do not invent numbers, trends or details. Use plain prose without headings, recommendations or a preamble. If every goal succeeded with no broken rules, say that in one sentence.`;
export async function populateSimulationExecutiveSummary(
  run: SimulationRun,
  options: { enabled: boolean; model: string; llmConfig?: LLMCallConfig },
): Promise<void> {
  if (!options.enabled || !run.results.length) return;
  let resolved: Awaited<ReturnType<typeof resolveLlmClient>>;
  try {
    resolved = await resolveLlmClient(
      options.llmConfig?.client as import("openai").default | undefined,
      { maxRetries: 0 },
    );
  } catch (error) {
    if (error instanceof MissingLLMCredentialsError) {
      console.warn(
        "Skipping executive summary: no LLM credentials configured.",
      );
      return;
    }
    throw error;
  }
  const summary = await generateExecutiveSummary(
    buildSimulationFacts(run.results),
    {
      llmClient: resolved.client,
      model: options.model,
      systemPrompt: SYSTEM_PROMPT,
      config: options.llmConfig,
    },
  );
  run.executiveSummary = summary.text;
  if (summary.usage)
    run.tokenUsageTotal = sumStructuredUsage([
      run.tokenUsageTotal,
      summary.usage,
    ]);
}
