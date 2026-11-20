import type OpenAI from "openai";
import { z } from "zod/v4";

import { checkRunActive, withRunLifecycle } from "../common/run-lifecycle.js";
import { delimit } from "../common/sanitize.js";
import {
  generateStructured,
  usageFromException,
} from "../common/structured-output.js";
import { renderTemplate } from "../common/template-engine.js";
import type { DimensionName } from "./models.js";
import type { UsageLedger } from "./usage.js";

const PROMPTS = {
  intent:
    "You are tasked with describing a group of related user intents with a short, precise, and accurate description and name. Your goal is to capture what users in this group were trying to accomplish, and to distinguish this group from other nearby groups.\n\nDescribe the group in 3-4 clear sentences in the past tense. Focus exclusively on the user's goal or task - not on the outcome, quality of the response, or the user's emotional state. Your description should distinguish this group from the contrastive examples.\n\nAfter creating the description, generate a short name for the group. The name must be an imperative sentence that describes the user's intent (e.g., 'Configure CI/CD pipelines for Python projects', 'Debug memory leaks in Node.js applications', or 'Generate product descriptions for an e-commerce site'). The name should be at most ten words long, specific enough to be meaningful, but broad enough to represent the whole group.\n\nThe name should distinguish this group from the contrastive examples by the specific intent or goal, not by success, failure, or sentiment. NEVER start the name with 'Summarize' - you are describing a user intent, not performing summarization.\n\nProvide your response as structured JSON with these fields:\n- \"name\": the imperative cluster name (max 10 words)\n- \"description\": the 3-4 sentence description in past tense\n\nBelow are the user intent examples in this group:\n{{examples}}\n\nFor context, here are examples from nearby groups that are NOT in this group:\n{{contrastive}}\n\nAnalyze the examples carefully and focus on the user's intent and task, not on sentiment, frustration, or whether the assistant succeeded.",
  sentiment:
    "You are tasked with describing a group of related user sentiment patterns. Your goal is to capture the root cause shared by users in this group, and to distinguish this group from other nearby groups.\n\nThe examples below are sentiment descriptions - each describes how a user felt and why. Your job is to describe the cause of the sentiment pattern, NOT to summarize conversations.\n\nDescribe the group in 3-4 clear sentences in the past tense. Focus on the emotional pattern and WHY it occurred, not on what the user was doing. Your description should distinguish this group from the contrastive examples.\n\nAfter creating the description, generate a short name for the group. The name must describe the root cause (e.g., 'Frustrated by repeated incorrect code suggestions', 'Satisfied after completing a complex migration in one exchange', or 'Neutral toward verbose but technically correct responses'). The name should be at most ten words long.\n\nThe name should distinguish this group from the contrastive examples by the specific cause, not by the task or topic. NEVER start the name with 'Summarize' - you are describing a sentiment pattern, not performing summarization.\n\nProvide your response as structured JSON with these fields:\n- \"name\": the sentiment pattern name (max 10 words), describing the root cause\n- \"description\": the 3-4 sentence description in past tense\n\nBelow are the sentiment description examples in this group:\n{{examples}}\n\nFor context, here are examples from nearby groups that are NOT in this group:\n{{contrastive}}\n\nAnalyze the examples carefully and focus on the root cause of the sentiment.",
  failure:
    "You are tasked with describing a group of related assistant failure patterns with a short, precise, and accurate description and name. Your goal is to capture the specific failure mechanism shared across this group, and to distinguish it from other failure modes in nearby groups.\n\nDescribe the group in 3-4 clear sentences in the past tense. Focus on WHAT went wrong and HOW - the specific failure mechanism - not on the user's sentiment or the topic of the conversation. Your description should distinguish this group from the contrastive examples.\n\nAfter creating the description, generate a short name for the group. The name must describe the specific failure mode (e.g., 'Hallucinated non-existent API endpoints', 'Truncated code completions without warning', or 'Produced syntactically valid but logically incorrect SQL queries'). The name should be at most ten words long.\n\nThe name should distinguish this group from the contrastive examples by the specific failure mechanism - not by the topic, user sentiment, or severity. NEVER start the name with 'Summarize' - you are describing a failure pattern, not performing summarization.\n\nProvide your response as structured JSON with these fields:\n- \"name\": the failure mode name (max 10 words), describing what went wrong\n- \"description\": the 3-4 sentence description in past tense\n\nBelow are the failure description examples in this group:\n{{examples}}\n\nFor context, here are examples from nearby groups that are NOT in this group:\n{{contrastive}}\n\nAnalyze the examples carefully and focus on the specific failure mechanism.",
  top: 'You are tasked with naming a broader group of related clusters, given the name and description of each of its child clusters. Your goal is to capture the shared theme across all the children in a short, precise, and accurate name and description.\n\nDescribe the group in 2-3 clear sentences in the past tense, capturing what unifies the children. After creating the description, generate a short name for the group, at most ten words long, that reflects the shared theme of its children rather than any single one of them.\n\nProvide your response as structured JSON with these fields:\n- "name": the group name (max 10 words)\n- "description": the 2-3 sentence description in past tense\n\nBelow are the child clusters of this group:\n{{children}}\n\nAnalyze the children carefully and focus on what unifies them.',
} as const;

export interface ClusterName {
  name: string;
  description: string;
}
const schema = z.object({ name: z.string(), description: z.string() });

export function boundDescriptionExcerpts(texts: readonly string[]): string[] {
  const result: string[] = [];
  let remaining = 6000;
  for (let i = 0; i < texts.length; i++) {
    const available = remaining - (result.length ? 1 : 0);
    if (available <= 0) break;
    const limit = Math.min(1000, Math.floor(available / (texts.length - i)));
    const chars = Array.from(texts[i] as string);
    let text = chars.join("");
    if (chars.length > limit) {
      const marker = " … [excerpt truncated] … ";
      const markerLength = Array.from(marker).length;
      if (limit <= markerLength) text = chars.slice(0, limit).join("");
      else {
        const head = Math.floor(((limit - markerLength) * 3) / 4);
        const tail = limit - markerLength - head;
        text =
          chars.slice(0, head).join("") +
          marker +
          (tail ? chars.slice(-tail).join("") : "");
      }
    }
    result.push(text);
    remaining -= Array.from(text).length + (result.length > 1 ? 1 : 0);
  }
  return result;
}

export function buildDescribePrompt(
  dimension: DimensionName,
  members: readonly string[],
  contrastive: readonly string[],
): string {
  const originals = [...members, ...contrastive],
    bounded = boundDescriptionExcerpts(originals);
  if (
    bounded.length !== originals.length ||
    bounded.some((text, i) => text !== originals[i])
  )
    console.warn(
      "Insights description examples were truncated to the shared 6000-character context budget",
    );
  return renderTemplate(PROMPTS[dimension], {
    examples: delimit(bounded.slice(0, members.length).join("\n") || "(none)", {
      tag: "examples",
    }),
    contrastive: delimit(bounded.slice(members.length).join("\n") || "(none)", {
      tag: "contrastive",
    }),
  });
}

export function buildTopDescribePrompt(
  children: readonly ClusterName[],
): string {
  const texts = children.map(
      (child) => `- ${child.name}: ${child.description}`,
    ),
    bounded = boundDescriptionExcerpts(texts.slice(0, 50));
  if (
    bounded.length !== texts.length ||
    bounded.some((text, i) => text !== texts[i])
  )
    console.warn(
      "Insights top-level description children were truncated to 50 children and the shared 6000-character context budget",
    );
  return renderTemplate(PROMPTS.top, {
    children: delimit(bounded.join("\n"), { tag: "children" }),
  });
}

export interface DescribeOptions {
  client: OpenAI;
  model: string;
  parallelism?: number;
  usage?: UsageLedger;
  signal?: AbortSignal;
}

async function describe(
  prompts: Readonly<Record<number, string>>,
  options: DescribeOptions,
  label: string,
): Promise<Record<number, ClusterName | string>> {
  const parallelism = options.parallelism ?? 20;
  if (!Number.isInteger(parallelism) || parallelism < 1)
    throw new RangeError("parallelism must be positive");
  const entries = Object.entries(prompts),
    results: Record<number, ClusterName | string> = {};
  let next = 0;
  return withRunLifecycle(
    parallelism,
    async () => {
      const worker = async () => {
        while (next < entries.length) {
          checkRunActive();
          const [id, prompt] = entries[next++] as [string, string];
          try {
            const response = await generateStructured(options.client, {
              model: options.model,
              messages: [{ role: "user", content: prompt }],
              responseFormat: { name: "ClusterName", schema },
              maxTokens: 4096,
              label,
            });
            checkRunActive();
            options.usage?.add("describe", response.usage);
            results[Number(id)] =
              response.parsed ?? "describe: unparseable model output";
          } catch (error) {
            checkRunActive();
            options.usage?.add("describe", usageFromException(error));
            results[Number(id)] =
              `describe: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      };
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(parallelism, entries.length) }, worker),
      );
      const failure = settled.find((item) => item.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return results;
    },
    options.signal,
  );
}

export function describeClusters(
  members: Readonly<Record<number, readonly string[]>>,
  neighbours: Readonly<Record<number, readonly number[]>>,
  dimension: DimensionName,
  options: DescribeOptions,
): Promise<Record<number, ClusterName | string>> {
  return describe(
    Object.fromEntries(
      Object.entries(members).map(([id, texts]) => {
        const contrastive = (neighbours[Number(id)] ?? [])
          .slice(0, 3)
          .flatMap((neighbour) => (members[neighbour] ?? []).slice(0, 3));
        return [
          id,
          buildDescribePrompt(dimension, texts.slice(0, 10), contrastive),
        ];
      }),
    ),
    options,
    "insights.describe",
  );
}

export function describeTopLevel(
  children: Readonly<Record<number, readonly ClusterName[]>>,
  options: DescribeOptions,
): Promise<Record<number, ClusterName | string>> {
  return describe(
    Object.fromEntries(
      Object.entries(children).map(([id, values]) => [
        id,
        buildTopDescribePrompt(values),
      ]),
    ),
    options,
    "insights.describe_top_level",
  );
}
