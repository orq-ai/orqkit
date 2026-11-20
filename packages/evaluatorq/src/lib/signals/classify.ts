import type OpenAI from "openai";

import { ClassifyQuestionSchema, runJudge } from "../common/judge.js";
import { resolveLlmClient } from "../common/llm-client.js";
import { LLMCallConfig } from "../contracts.js";
import type { AtifTrajectoryFields } from "../formats/atif.js";
import { SignalsConfig, type ToolRole } from "./config.js";
import { calls, walk } from "./walk.js";

const ROLE_CRITERIA = Object.freeze({
  bash: "Runs shell commands or otherwise executes operating-system commands.",
  webview: "Browses, fetches, or views web pages and other online content.",
  skill: "Loads or invokes a named skill or reusable capability.",
  subagent: "Delegates work to another agent or starts a child agent.",
  other: "Does not fit any of the other tool roles.",
});
export async function classifyToolRoles(
  trajectories: Iterable<AtifTrajectoryFields>,
  options: { config?: SignalsConfig | null; client?: OpenAI | null } = {},
): Promise<SignalsConfig> {
  const config = options.config ?? new SignalsConfig(),
    names: string[] = [],
    seen = new Set<string>();
  for (const trajectory of trajectories)
    for (const record of calls(walk(trajectory))) {
      const name = record.call.functionName;
      if (!Object.hasOwn(config.toolRoles, name) && !seen.has(name)) {
        names.push(name);
        seen.add(name);
      }
    }
  if (!names.length) return config;
  let client = options.client;
  if (!client) {
    try {
      client = (await resolveLlmClient(null, { maxRetries: 0 })).client;
    } catch (error) {
      for (const name of names)
        console.warn(
          `Tool role classification failed for tool ${name}: ${String(error)}`,
        );
      return new SignalsConfig({
        ...config.toJSON(),
        toolRoles: {
          ...config.toolRoles,
          ...Object.fromEntries(names.map((name) => [name, "other"])),
        },
      });
    }
  }
  const roles: Record<string, ToolRole> = {};
  for (const name of names) {
    try {
      const outcome = await runJudge({
        client,
        model: config.classifier.model,
        cfg: new LLMCallConfig({
          model: config.classifier.model,
          timeoutMs: 90000,
        }),
        promptTemplate: "",
        replacements: {},
        spanAttributes: { "orq.llm.purpose": "judge" },
        classify: ClassifyQuestionSchema.parse({
          kind: "choice",
          instructions: "Choose the role that best describes this tool.",
          criteria: ROLE_CRITERIA,
          state: { tool_name: name },
        }),
      });
      const value = outcome.payload?.value;
      if (
        outcome.errorKind !== null ||
        !outcome.payload ||
        outcome.payload.abstain
      )
        throw new Error(
          outcome.errorMessage || "classifier returned no decisive verdict",
        );
      if (typeof value !== "string" || !Object.hasOwn(ROLE_CRITERIA, value))
        throw new Error(
          `classifier returned invalid role ${JSON.stringify(value)}`,
        );
      Object.defineProperty(roles, name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      console.warn(
        `Tool role classification failed for tool ${name}: ${String(error)}`,
      );
      Object.defineProperty(roles, name, {
        value: "other",
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return new SignalsConfig({
    ...config.toJSON(),
    toolRoles: { ...roles, ...config.toolRoles },
  });
}
