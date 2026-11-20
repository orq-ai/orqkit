import { codepointCompare } from "../common/sanitize.js";
import type { MessageInput } from "../contracts.js";
import { AtifTrajectory } from "../formats/atif.js";
import { ChatConversation } from "../formats/chat.js";
import { OtelTrace } from "../formats/otel.js";
import { ResponsesConversation } from "../formats/responses.js";
import type { Evaluator } from "../types.js";
import type { SignalsConfig } from "./config.js";
import type { SignalResult } from "./models.js";
import { computeSignals, SIGNAL_NAMES, SIGNALS } from "./registry.js";
import { pyString } from "./walk.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function toTrajectory(output: unknown): AtifTrajectory | null {
  try {
    if (output instanceof AtifTrajectory) return output;
    if (
      output instanceof ChatConversation ||
      output instanceof ResponsesConversation ||
      output instanceof OtelTrace
    )
      return output.toAtif();
    const messages = Array.isArray(output)
      ? output
      : record(output)
        ? output.messages
        : null;
    if (Array.isArray(messages) && messages.every(record))
      return new ChatConversation({
        messages: messages as MessageInput[],
      }).toAtif();
  } catch (error) {
    console.warn(
      `Could not convert evaluator output to ATIF: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  return null;
}
function references(result: SignalResult): string {
  const refs = result.evidence.map((item) =>
      item.callId === null
        ? `step ${item.stepId}`
        : `step ${item.stepId} / call ${item.callId}`,
    ),
    shown = refs.slice(0, 10);
  if (refs.length > 10) shown.push(`(+${refs.length - 10} more)`);
  return shown.join("; ");
}
export function signalEvaluator(
  name: string,
  options: { threshold?: number | null; config?: SignalsConfig | null } = {},
): Evaluator {
  if (!Object.hasOwn(SIGNALS, name))
    throw new RangeError(`Unknown signal name: ${name}`);
  return {
    name,
    scorer: async ({ output }) => {
      const trajectory = toTrajectory(output);
      if (!trajectory)
        return {
          value: null,
          pass: null,
          explanation: `Could not convert output of type ${output === null ? "null" : Array.isArray(output) ? "array" : typeof output} to an ATIF trajectory.`,
        };
      let result: SignalResult | undefined;
      try {
        result = computeSignals(trajectory, {
          config: options.config,
          only: [name],
        }).results[name];
      } catch (error) {
        return {
          value: null,
          pass: null,
          explanation: `Could not compute ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        };
      }
      if (!result) throw new Error(`Missing signal result: ${name}`);
      if (result.noBasis !== null)
        return {
          value: null,
          pass: null,
          explanation: `No basis for ${name}: ${result.noBasis}`,
        };
      if (result.value === null)
        return {
          value: null,
          pass: null,
          explanation: `Signal ${name} did not produce a value.`,
        };
      const value = result.value as
        | string
        | number
        | boolean
        | Record<string, unknown>;
      const refs = references(result);
      if (SIGNALS[name]?.[0] === "D")
        return {
          value,
          pass: !value,
          explanation:
            (result.reason || `Tag ${name} did not fire.`) +
            (refs ? ` (${refs})` : ""),
        };
      let passed: boolean | null = null,
        explanation = `Signal ${name} returned ${pyString(value)}`;
      if (options.threshold != null) {
        if (typeof value === "number") {
          passed = value <= options.threshold;
          explanation += ` (threshold ${pyString(options.threshold)}; values at or below pass)`;
        } else
          explanation += ` (threshold ${pyString(options.threshold)} cannot be applied to a non-numeric value)`;
      }
      if (refs) explanation += ` (${refs})`;
      return { value, pass: passed, explanation };
    },
  };
}
export function signalEvaluators(
  names: string | readonly string[] = "tags",
  options: { config?: SignalsConfig | null } = {},
): Evaluator[] {
  let selected: readonly string[];
  if (typeof names !== "string") selected = names;
  else if (names === "all") selected = SIGNAL_NAMES;
  else if (["tags", "A", "B", "C", "D"].includes(names))
    selected = SIGNAL_NAMES.filter(
      (name) => SIGNALS[name]?.[0] === (names === "tags" ? "D" : names),
    );
  else
    throw new RangeError(
      "names must be 'tags', 'all', a group letter, or a sequence of signal names",
    );
  const unknown = [...new Set(selected)]
    .filter((name) => !Object.hasOwn(SIGNALS, name))
    .sort(codepointCompare);
  if (unknown.length)
    throw new RangeError(`Unknown signal names: ${unknown.join(", ")}`);
  return selected.map((name) => signalEvaluator(name, options));
}
